/**
 * Lampa AVI: перекладка avi в matroska прямо на телевизоре.
 *
 * Запускается сервисом TizenBrew (Node.js на самом телевизоре) и слушает
 * http://127.0.0.1:8898. Плеер телевизора не открывает avi по сети, но те же
 * дорожки в matroska играет. Сервис собирает matroska виртуально: заголовок,
 * таблица перемотки и заголовки блоков вычисляются из индекса avi, а сами кадры
 * читаются из исходного файла диапазонами (Range) в момент запроса. Файл целиком
 * никуда не копируется и не перекодируется, поэтому места и процессора не нужно,
 * а длительность и перемотка работают с первой секунды.
 *
 *   GET  /health                   жив ли сервис
 *   GET  /open?url=<avi>           разобрать файл заранее, вернуть описание дорожек
 *   GET  /mkv/<имя>.mkv?url=<avi>  сам виртуальный файл, поддерживает Range и HEAD
 *   GET  /log                      последние строки журнала
 *
 * Код намеренно на ES5: на старых прошивках в сервисе Tizen стоит Node.js 4.
 * Локально запускается как `node tizenbrew/service.js [порт]`.
 */
(function () {
    'use strict';

    var http = require('http');
    var https = require('https');
    var urlLib = require('url');

    var VERSION = '1.0.0';
    var DEFAULT_PORT = 8898;
    var UPSTREAM_TIMEOUT = 120000;
    var MAX_SESSIONS = 3;

    // ------------------------------------------------------------------ журнал

    var journal = [];

    function log() {
        var line = new Date().toISOString() + ' ' + Array.prototype.slice.call(arguments).join(' ');

        journal.push(line);
        if (journal.length > 300) journal.shift();

        try { console.log('[lampa-avi] ' + line); } catch (e) {}
    }

    // ------------------------------------------------------------------ буферы

    // В Node.js 4.4 ещё нет Buffer.alloc и Buffer.from, а Buffer.from там
    // унаследован от Uint8Array и возвращает не Buffer
    var modernBuffer = typeof Buffer.alloc === 'function';

    function alloc(size) {
        if (modernBuffer) return Buffer.alloc(size);

        var b = new Buffer(size);
        b.fill(0);

        return b;
    }

    function bytes(value, encoding) {
        return modernBuffer ? Buffer.from(value, encoding) : new Buffer(value, encoding);
    }

    var LATIN = Buffer.isEncoding && Buffer.isEncoding('latin1') ? 'latin1' : 'binary';

    function fourcc(buf, pos) {
        return buf.toString(LATIN, pos, pos + 4);
    }

    function u16(buf, pos) { return buf.readUInt16LE(pos); }
    function u32(buf, pos) { return buf.readUInt32LE(pos); }

    function u64(buf, pos) {
        return buf.readUInt32LE(pos) + buf.readUInt32LE(pos + 4) * 4294967296;
    }

    // ------------------------------------------------------------------ EBML

    function ebmlId(id) {
        var list = [];

        while (id > 0) {
            list.unshift(id % 256);
            id = Math.floor(id / 256);
        }

        return bytes(list);
    }

    /**
     * Размер элемента в виде vint. width задаёт фиксированную ширину, иначе
     * выбирается минимальная
     */
    function vint(value, width) {
        if (!width) {
            width = 1;
            while (value >= Math.pow(2, 7 * width) - 1) width++;
        }

        var b = alloc(width);
        var rest = value;

        for (var i = width - 1; i >= 0; i--) {
            b[i] = rest % 256;
            rest = Math.floor(rest / 256);
        }

        b[0] |= 0x80 >> (width - 1);

        return b;
    }

    function uint(value, width) {
        if (!width) {
            width = 1;
            while (value >= Math.pow(2, 8 * width)) width++;
        }

        var b = alloc(width);
        var rest = value;

        for (var i = width - 1; i >= 0; i--) {
            b[i] = rest % 256;
            rest = Math.floor(rest / 256);
        }

        return b;
    }

    function el(id, payload, sizeWidth) {
        return Buffer.concat([ebmlId(id), vint(payload.length, sizeWidth), payload]);
    }

    function elUint(id, value, width) { return el(id, uint(value, width)); }
    function elText(id, text) { return el(id, bytes(String(text), 'utf8')); }

    function elFloat(id, value) {
        var b = alloc(8);

        b.writeDoubleBE(value, 0);

        return el(id, b);
    }

    var ID = {
        EBML: 0x1A45DFA3,
        Segment: 0x18538067,
        SeekHead: 0x114D9B74,
        Seek: 0x4DBB,
        SeekID: 0x53AB,
        SeekPosition: 0x53AC,
        Info: 0x1549A966,
        TimecodeScale: 0x2AD7B1,
        Duration: 0x4489,
        MuxingApp: 0x4D80,
        WritingApp: 0x5741,
        Tracks: 0x1654AE6B,
        TrackEntry: 0xAE,
        TrackNumber: 0xD7,
        TrackUID: 0x73C5,
        TrackType: 0x83,
        FlagDefault: 0x88,
        FlagLacing: 0x9C,
        Language: 0x22B59C,
        CodecID: 0x86,
        CodecPrivate: 0x63A2,
        Name: 0x536E,
        DefaultDuration: 0x23E383,
        Video: 0xE0,
        PixelWidth: 0xB0,
        PixelHeight: 0xBA,
        Audio: 0xE1,
        SamplingFrequency: 0xB5,
        Channels: 0x9F,
        BitDepth: 0x6264,
        Cues: 0x1C53BB6B,
        CuePoint: 0xBB,
        CueTime: 0xB3,
        CueTrackPositions: 0xB7,
        CueTrack: 0xF7,
        CueClusterPosition: 0xF1,
        Cluster: 0x1F43B675,
        Timecode: 0xE7,
        SimpleBlock: 0xA3
    };

    // заголовок кластера: ID(4) + размер(8) + Timecode(E7 84 + 4 байта)
    var CLUSTER_HEAD = 18;
    // заголовок блока: A3 + размер(4) + дорожка(1) + время(2) + флаги(1)
    var BLOCK_HEAD = 9;

    // ------------------------------------------------------------------ сеть

    function requestUpstream(src, headers, done, redirects) {
        var opts = urlLib.parse(src);
        var lib = opts.protocol === 'https:' ? https : http;
        var finished = false;

        opts.headers = headers || {};
        opts.agent = false;

        var req = lib.get(opts, function (res) {
            if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location && (redirects || 0) < 5) {
                res.resume();
                finished = true;

                return requestUpstream(urlLib.resolve(src, res.headers.location), headers, done, (redirects || 0) + 1);
            }

            finished = true;
            done(null, res, req);
        });

        req.on('error', function (err) {
            if (finished) return;
            finished = true;
            done(err);
        });

        req.setTimeout(UPSTREAM_TIMEOUT, function () {
            req.abort();
        });

        return req;
    }

    function totalFromHeaders(res) {
        var range = res.headers['content-range'];
        var match = range && /\/(\d+)\s*$/.exec(range);

        if (match) return parseInt(match[1], 10);
        if (res.statusCode === 200 && res.headers['content-length']) return parseInt(res.headers['content-length'], 10);

        return 0;
    }

    /**
     * Читает length байт с позиции start
     */
    function readRange(src, start, length, done) {
        var end = start + length - 1;

        requestUpstream(src, { Range: 'bytes=' + start + '-' + end }, function (err, res, req) {
            if (err) return done(err);

            if (res.statusCode !== 206 && !(res.statusCode === 200 && start === 0)) {
                res.resume();

                return done(new Error('источник ответил ' + res.statusCode + ' на запрос диапазона'));
            }

            var total = totalFromHeaders(res);
            var parts = [];
            var got = 0;
            var closed = false;

            function finish() {
                if (closed) return;
                closed = true;

                var buf = Buffer.concat(parts, got);

                done(null, buf.length > length ? buf.slice(0, length) : buf, total);
            }

            res.on('data', function (chunk) {
                parts.push(chunk);
                got += chunk.length;

                // сервер без поддержки Range отдаёт весь файл: хватит того, что нужно
                if (got >= length) {
                    req.abort();
                    finish();
                }
            });

            res.on('end', finish);
            // обрыв соединения без end: отдаём то, что успели получить
            res.on('aborted', finish);
            res.on('close', finish);
            res.on('error', function (e) {
                if (closed) return;
                closed = true;
                done(e);
            });
        });
    }

    // ------------------------------------------------------------------ разбор AVI

    var ASP_TAGS = ['XVID', 'DIVX', 'DX50', 'FMP4', 'MP4V', '3IV2', 'XVIX', 'M4S2', 'RMP4', 'SEDG',
        'WV1F', 'UMP4', 'BLZ0', 'DM4V', 'SMP4', 'M4CC', 'DXGM', 'HDX4', 'LMP4', 'NDIG', 'EM4A',
        'FVFW', 'DIV4', 'DIV5', 'DIV6', 'DCOD', 'GEOX', 'QMP4', 'VIDM', 'XVIX', 'MP4S', 'EPHV', 'DP02'];

    function audioCodec(tag, strf) {
        if (tag === 0xFFFE && strf.length >= 26) tag = u16(strf, 24);

        switch (tag) {
            case 0x0055: return { id: 'A_MPEG/L3' };
            case 0x0050: return { id: 'A_MPEG/L2' };
            case 0x2000: return { id: 'A_AC3' };
            case 0x2001: return { id: 'A_DTS' };
            case 0x0001: return { id: 'A_PCM/INT/LIT', pcm: true };
            case 0x0003: return { id: 'A_PCM/FLOAT/IEEE', pcm: true };
            case 0x00FF:
            case 0x706D:
            case 0x4143:
            case 0xA106: {
                var cb = strf.length >= 18 ? u16(strf, 16) : 0;

                if (cb > 0 && strf.length >= 18 + cb) return { id: 'A_AAC', priv: strf.slice(18, 18 + cb) };

                break;
            }
        }

        return { id: 'A_MS/ACM', priv: strf };
    }

    /**
     * Разбирает верх файла: список потоков и положение movi.
     * Возвращает null, если данных не хватило и нужно прочитать больше
     */
    function parseHeader(buf) {
        if (buf.length < 12 || fourcc(buf, 0) !== 'RIFF' || fourcc(buf, 8).slice(0, 3) !== 'AVI') {
            throw new Error('это не avi');
        }

        var info = { streams: [], movi: 0, moviEnd: 0, avih: null };
        var pos = 12;

        while (pos + 8 <= buf.length) {
            var id = fourcc(buf, pos);
            var size = u32(buf, pos + 4);

            if (id === 'LIST') {
                if (pos + 12 > buf.length) return null;

                var type = fourcc(buf, pos + 8);

                if (type === 'movi') {
                    info.movi = pos + 8;
                    info.moviEnd = pos + 8 + size;

                    return info;
                }

                if (type === 'hdrl') {
                    if (pos + 8 + size > buf.length) return null;

                    parseHdrl(buf, pos + 12, pos + 8 + size, info);
                }
            }

            pos += 8 + size + (size & 1);
        }

        return null;
    }

    function parseHdrl(buf, pos, end, info) {
        while (pos + 8 <= end) {
            var id = fourcc(buf, pos);
            var size = u32(buf, pos + 4);
            var body = pos + 8;

            if (id === 'avih') {
                info.avih = {
                    usPerFrame: u32(buf, body),
                    totalFrames: u32(buf, body + 16),
                    width: u32(buf, body + 32),
                    height: u32(buf, body + 36)
                };
            }
            else if (id === 'LIST' && fourcc(buf, body) === 'strl') {
                info.streams.push(parseStrl(buf, body + 4, body + size, info.streams.length));
            }

            pos = body + size + (size & 1);
        }
    }

    function parseStrl(buf, pos, end, number) {
        var stream = { number: number, type: '', handler: '', scale: 1, rate: 1, start: 0, sampleSize: 0, strf: null, indx: null, name: '' };

        while (pos + 8 <= end) {
            var id = fourcc(buf, pos);
            var size = u32(buf, pos + 4);
            var body = pos + 8;

            if (id === 'strh') {
                stream.type = fourcc(buf, body);
                stream.handler = fourcc(buf, body + 4);
                stream.scale = u32(buf, body + 20) || 1;
                stream.rate = u32(buf, body + 24) || 1;
                stream.start = u32(buf, body + 28);
                stream.sampleSize = u32(buf, body + 44);
            }
            else if (id === 'strf') {
                stream.strf = buf.slice(body, body + size);
            }
            else if (id === 'indx') {
                stream.indx = buf.slice(body, body + size);
            }
            else if (id === 'strn') {
                stream.name = buf.toString('utf8', body, body + size).replace(/\0.*$/, '');
            }

            pos = body + size + (size & 1);
        }

        return stream;
    }

    /**
     * Номер потока из идентификатора чанка вида 00dc / 01wb, либо -1
     */
    function chunkStream(buf, pos) {
        var a = buf[pos] - 48;
        var b = buf[pos + 1] - 48;

        if (a < 0 || a > 9 || b < 0 || b > 9) return -1;

        var kind = String.fromCharCode(buf[pos + 2], buf[pos + 3]);

        // смена палитры и прочие служебные чанки не относятся к кадрам
        if (kind === 'pc') return -1;

        return a * 10 + b;
    }

    // ------------------------------------------------------------------ индекс

    function StreamIndex() {
        this.count = 0;
        this.pos = new Float64Array(1024);
        this.size = new Uint32Array(1024);
        this.key = new Uint8Array(1024);
    }

    StreamIndex.prototype.push = function (pos, size, key) {
        if (this.count === this.pos.length) {
            var grow = this.pos.length * 2;
            var p = new Float64Array(grow);
            var s = new Uint32Array(grow);
            var k = new Uint8Array(grow);

            p.set(this.pos);
            s.set(this.size);
            k.set(this.key);

            this.pos = p;
            this.size = s;
            this.key = k;
        }

        this.pos[this.count] = pos;
        this.size[this.count] = size;
        this.key[this.count] = key ? 1 : 0;
        this.count++;
    };

    /**
     * Индекс старого формата idx1 в конце movi
     */
    function readIdx1(src, header, total, wanted, done) {
        var at = header.moviEnd + (header.moviEnd & 1);

        if (at + 8 > total) return done(new Error('в файле нет индекса idx1'));

        readRange(src, at, 8, function (err, head) {
            if (err) return done(err);
            if (head.length < 8 || fourcc(head, 0) !== 'idx1') return done(new Error('в файле нет индекса idx1'));

            var size = u32(head, 4);

            log('индекс idx1:', size, 'байт');

            readRange(src, at + 8, size, function (err2, buf) {
                if (err2) return done(err2);

                var indexes = {};
                var n = Math.floor(buf.length / 16);
                var base = -1;

                wanted.forEach(function (number) { indexes[number] = new StreamIndex(); });

                for (var i = 0; i < n; i++) {
                    var p = i * 16;
                    var number = chunkStream(buf, p);

                    if (number < 0 || !indexes[number]) continue;

                    var flags = u32(buf, p + 4);
                    var offset = u32(buf, p + 8);
                    var length = u32(buf, p + 12);

                    if (flags & 0x01) continue; // запись про LIST, а не про кадр

                    // смещения бывают от начала movi, а бывают абсолютные
                    if (base < 0) base = offset < header.movi ? header.movi : 0;

                    indexes[number].push(base + offset + 8, length, flags & 0x10);
                }

                if (base < 0) return done(new Error('индекс idx1 пуст'));

                done(null, indexes, base);
            });
        });
    }

    /**
     * Индекс OpenDML: супериндекс в заголовке потока и части ix## по файлу
     */
    function readOpenDml(src, streams, wanted, done) {
        var indexes = {};
        var jobs = [];

        wanted.forEach(function (number) {
            var indx = streams[number].indx;

            indexes[number] = new StreamIndex();

            var perEntry = u16(indx, 0);
            var type = indx[3];
            var entries = u32(indx, 4);

            if (type === 0x01) {
                // стандартный индекс прямо в заголовке, бывает редко
                jobs.push({ number: number, inline: indx });
                return;
            }

            for (var i = 0; i < entries; i++) {
                var p = 24 + i * perEntry * 4;

                if (p + 16 > indx.length) break;

                jobs.push({ number: number, offset: u64(indx, p), size: u32(indx, p + 8) });
            }
        });

        var parts = {};
        var pending = jobs.length;
        var failed = false;
        var next = 0;
        var running = 0;

        function parseStd(buf, number, key) {
            var perEntry = u16(buf, 0);
            var entries = u32(buf, 4);
            var baseOffset = u64(buf, 12);
            var list = [];

            for (var i = 0; i < entries; i++) {
                var p = 24 + i * perEntry * 4;

                if (p + 8 > buf.length) break;

                var size = u32(buf, p + 4);

                list.push([baseOffset + u32(buf, p), size & 0x7FFFFFFF, !(size & 0x80000000)]);
            }

            parts[key] = { number: number, list: list };
        }

        function finish() {
            // части одного потока складываем в порядке их позиций в файле
            var keys = Object.keys(parts).sort(function (a, b) { return a - b; });

            keys.forEach(function (key) {
                var part = parts[key];

                part.list.forEach(function (e) {
                    indexes[part.number].push(e[0], e[1], e[2]);
                });
            });

            done(null, indexes);
        }

        function launch() {
            while (running < 4 && next < jobs.length) {
                (function (job, key) {
                    if (job.inline) {
                        parseStd(job.inline, job.number, key);
                        pending--;
                        return;
                    }

                    running++;

                    readRange(src, job.offset, job.size + 8, function (err, buf) {
                        running--;

                        if (failed) return;

                        if (err || buf.length < 32 || fourcc(buf, 0).slice(0, 2) !== 'ix') {
                            failed = true;

                            return done(err || new Error('повреждён индекс OpenDML'));
                        }

                        parseStd(buf.slice(8), job.number, key);

                        pending--;

                        if (!pending) finish();
                        else launch();
                    });
                })(jobs[next], next++);
            }

            if (!pending && !failed) finish();
        }

        if (!jobs.length) return done(new Error('пустой индекс OpenDML'));

        launch();
    }

    // ------------------------------------------------------------------ дорожки

    /**
     * Начало потока mpeg4 до первого кадра: VOS, VO и VOL. В matroska это
     * CodecPrivate, без него декодер не узнает размеры и параметры кадра
     */
    function extractVol(frame) {
        if (frame.length < 4 || frame[0] !== 0 || frame[1] !== 0 || frame[2] !== 1) return null;

        for (var i = 0; i + 3 < frame.length; i++) {
            if (frame[i] === 0 && frame[i + 1] === 0 && frame[i + 2] === 1 && frame[i + 3] === 0xB6) {
                return i > 0 ? frame.slice(0, i) : null;
            }
        }

        return null;
    }

    function describeVideo(stream, header) {
        var strf = stream.strf || alloc(40);
        var compression = strf.length >= 20 ? fourcc(strf, 16) : stream.handler;
        var tag = compression.toUpperCase();
        var handler = stream.handler.toUpperCase();
        var asp = ASP_TAGS.indexOf(tag) >= 0 || ASP_TAGS.indexOf(handler) >= 0;
        var width = strf.length >= 8 ? strf.readInt32LE(4) : (header.avih ? header.avih.width : 0);
        var height = strf.length >= 12 ? Math.abs(strf.readInt32LE(8)) : (header.avih ? header.avih.height : 0);
        var extra = null;

        if (strf.length > 40) {
            var tail = strf.slice(40);

            if (tail.length >= 4 && tail[0] === 0 && tail[1] === 0 && tail[2] === 1) extra = tail;
        }

        var frameSeconds = stream.scale / stream.rate;

        if (!(frameSeconds > 0 && frameSeconds < 10) && header.avih && header.avih.usPerFrame) {
            frameSeconds = header.avih.usPerFrame / 1e6;
        }

        return {
            kind: 'video',
            stream: stream.number,
            tag: compression,
            asp: asp,
            width: width,
            height: height,
            bih: strf,
            extra: extra,
            frameSeconds: frameSeconds,
            name: stream.name
        };
    }

    function describeAudio(stream) {
        var strf = stream.strf || alloc(18);
        var tag = strf.length >= 2 ? u16(strf, 0) : 0;
        var codec = audioCodec(tag, strf);

        return {
            kind: 'audio',
            stream: stream.number,
            tag: tag,
            codec: codec.id,
            priv: codec.priv || null,
            pcm: Boolean(codec.pcm),
            channels: strf.length >= 4 ? u16(strf, 2) : 2,
            rate: strf.length >= 8 ? u32(strf, 4) : 48000,
            bits: strf.length >= 16 ? u16(strf, 14) : 16,
            scale: stream.scale,
            rateDiv: stream.rate,
            start: stream.start,
            sampleSize: stream.sampleSize,
            name: stream.name
        };
    }

    /**
     * Время каждого кадра потока в миллисекундах
     */
    function timesFor(track, index, stream) {
        var times = new Float64Array(index.count);

        if (track.kind === 'video') {
            for (var i = 0; i < index.count; i++) {
                times[i] = (stream.start + i) * track.frameSeconds * 1000;
            }

            return { times: times, end: (stream.start + index.count) * track.frameSeconds * 1000 };
        }

        var unit = stream.scale / stream.rate;
        var bytesSoFar = 0;
        var end = 0;

        for (var j = 0; j < index.count; j++) {
            if (stream.sampleSize > 0) {
                times[j] = (stream.start + bytesSoFar / stream.sampleSize) * unit * 1000;
                bytesSoFar += index.size[j];
                end = (stream.start + bytesSoFar / stream.sampleSize) * unit * 1000;
            }
            else {
                times[j] = (stream.start + j) * unit * 1000;
                end = (stream.start + j + 1) * unit * 1000;
            }
        }

        return { times: times, end: end };
    }

    // ------------------------------------------------------------------ сборка matroska

    function trackEntry(track, number, mode, isFirstAudio) {
        var parts = [
            elUint(ID.TrackNumber, number),
            elUint(ID.TrackUID, number),
            elUint(ID.TrackType, track.kind === 'video' ? 1 : 2),
            elUint(ID.FlagLacing, 0),
            elUint(ID.FlagDefault, track.kind === 'video' || isFirstAudio ? 1 : 0),
            elText(ID.Language, 'und')
        ];

        if (track.kind === 'video') {
            if (track.asp && mode !== 'vfw') {
                parts.push(elText(ID.CodecID, 'V_MPEG4/ISO/ASP'));
                if (track.extra) parts.push(el(ID.CodecPrivate, track.extra));
            }
            else {
                parts.push(elText(ID.CodecID, 'V_MS/VFW/FOURCC'));
                parts.push(el(ID.CodecPrivate, track.bih));
            }

            parts.push(elUint(ID.DefaultDuration, Math.round(track.frameSeconds * 1e9)));
            parts.push(el(ID.Video, Buffer.concat([
                elUint(ID.PixelWidth, track.width),
                elUint(ID.PixelHeight, track.height)
            ])));
        }
        else {
            parts.push(elText(ID.CodecID, track.codec));
            if (track.priv) parts.push(el(ID.CodecPrivate, track.priv));

            var audio = [elFloat(ID.SamplingFrequency, track.rate), elUint(ID.Channels, track.channels)];

            if (track.pcm) audio.push(elUint(ID.BitDepth, track.bits));

            parts.push(el(ID.Audio, Buffer.concat(audio)));
        }

        if (track.name) parts.push(elText(ID.Name, track.name));

        return el(ID.TrackEntry, Buffer.concat(parts));
    }

    function seekEntry(id, position) {
        return el(ID.Seek, Buffer.concat([
            el(ID.SeekID, ebmlId(id)),
            el(ID.SeekPosition, uint(position, 8))
        ]));
    }

    function cuePoint(time, position) {
        return el(ID.CuePoint, Buffer.concat([
            el(ID.CueTime, uint(time, 8)),
            el(ID.CueTrackPositions, Buffer.concat([
                el(ID.CueTrack, uint(1, 1)),
                el(ID.CueClusterPosition, uint(position, 8))
            ]))
        ]));
    }

    /**
     * Строит раскладку виртуального файла: блоки, кластеры, таблицу перемотки
     */
    function buildLayout(session, tracks, indexes, streams, mode) {
        var lists = [];
        var durationMs = 0;
        var totalBlocks = 0;

        tracks.forEach(function (track, i) {
            var index = indexes[track.stream];
            var timing = timesFor(track, index, streams[track.stream]);

            if (timing.end > durationMs) durationMs = timing.end;

            lists.push({ track: i + 1, video: track.kind === 'video', index: index, times: timing.times, at: 0 });
            totalBlocks += index.count;
        });

        // слияние потоков в порядке позиций в исходном файле: читаем его строго вперёд
        var srcPos = new Float64Array(totalBlocks);
        var size = new Uint32Array(totalBlocks);
        var trackOf = new Uint8Array(totalBlocks);
        var key = new Uint8Array(totalBlocks);
        var time = new Int32Array(totalBlocks);
        var n = 0;
        var lastEnd = 0;

        for (;;) {
            var best = null;

            for (var l = 0; l < lists.length; l++) {
                var list = lists[l];

                if (list.at < list.index.count && (!best || list.index.pos[list.at] < best.index.pos[best.at])) best = list;
            }

            if (!best) break;

            var at = best.at++;
            var pos = best.index.pos[at];
            var length = best.index.size[at];

            // пустые кадры (пропуски) только сдвигают время, блоков не дают;
            // пересекающиеся и выходящие за файл записи повреждённого индекса отбрасываем
            if (!length || pos < lastEnd || pos + length > session.total) continue;

            srcPos[n] = pos;
            size[n] = length;
            trackOf[n] = best.track;
            key[n] = best.video ? best.index.key[at] : 1;
            time[n] = Math.round(best.times[at]);
            lastEnd = pos + length;
            n++;
        }

        if (!n) throw new Error('в индексе нет ни одного кадра');

        // первый проход: границы кластеров. Новый кластер на каждом ключевом
        // кадре видео и при выходе относительного времени за пределы int16
        var isStart = new Uint8Array(n);
        var relTime = new Int16Array(n);
        var clusterTime = 0;
        var cueCount = 0;

        for (var j = 0; j < n; j++) {
            var videoKey = trackOf[j] === 1 && key[j];
            var delta = time[j] - clusterTime;

            if (j === 0 || videoKey || delta > 30000 || delta < -30000) {
                isStart[j] = 1;
                clusterTime = time[j];
                if (videoKey) cueCount++;
            }

            relTime[j] = time[j] - clusterTime;
        }

        // заголовок с фиксированной шириной всех полей, чтобы размер не зависел от значений
        var info = el(ID.Info, Buffer.concat([
            elUint(ID.TimecodeScale, 1000000),
            elFloat(ID.Duration, durationMs),
            elText(ID.MuxingApp, 'lampa-avi ' + VERSION),
            elText(ID.WritingApp, 'lampa-avi ' + VERSION)
        ]));

        var firstAudio = true;
        var tracksEl = el(ID.Tracks, Buffer.concat(tracks.map(function (track, i) {
            var entry = trackEntry(track, i + 1, mode, track.kind === 'audio' && firstAudio);

            if (track.kind === 'audio') firstAudio = false;

            return entry;
        })));

        var seekHeadSize = el(ID.SeekHead, Buffer.concat([seekEntry(ID.Info, 0), seekEntry(ID.Tracks, 0), seekEntry(ID.Cues, 0)]), 8).length;
        var cuesSize = 4 + 8 + cueCount * cuePoint(0, 0).length;
        var clustersStart = seekHeadSize + info.length + tracksEl.length + cuesSize;

        // второй проход: позиции блоков и размеры кластеров
        var out = new Float64Array(n + 1);
        var clusterSize = new Float64Array(n);
        var clusterStamp = new Int32Array(n);
        var cues = [];
        var rel = clustersStart;
        var current = -1;

        for (var k = 0; k < n; k++) {
            if (isStart[k]) {
                if (current >= 0) clusterSize[current] = rel - out[current] - 12;

                current = k;
                clusterStamp[k] = time[k] - relTime[k];

                if (trackOf[k] === 1 && key[k]) cues.push(cuePoint(clusterStamp[k], rel));

                out[k] = rel;
                rel += CLUSTER_HEAD + BLOCK_HEAD + size[k];
            }
            else {
                out[k] = rel;
                rel += BLOCK_HEAD + size[k];
            }
        }

        clusterSize[current] = rel - out[current] - 12;

        var segmentSize = rel;
        var seekHead = el(ID.SeekHead, Buffer.concat([
            seekEntry(ID.Info, seekHeadSize),
            seekEntry(ID.Tracks, seekHeadSize + info.length),
            seekEntry(ID.Cues, seekHeadSize + info.length + tracksEl.length)
        ]), 8);
        var cuesEl = Buffer.concat([ebmlId(ID.Cues), vint(cuesSize - 12, 8)].concat(cues));

        var ebml = el(ID.EBML, Buffer.concat([
            elUint(0x4286, 1),
            elUint(0x42F7, 1),
            elUint(0x42F2, 4),
            elUint(0x42F3, 8),
            elText(0x4282, 'matroska'),
            elUint(0x4287, 2),
            elUint(0x4285, 2)
        ]));

        var head = Buffer.concat([ebml, ebmlId(ID.Segment), vint(segmentSize, 8), seekHead, info, tracksEl, cuesEl]);
        var offset = head.length - clustersStart;

        // позиции блоков были относительны начала сегмента, делаем абсолютными
        for (var m = 0; m < n; m++) out[m] += offset;
        out[n] = rel + offset;

        session.head = head;
        session.count = n;
        session.srcPos = srcPos;
        session.size = size;
        session.track = trackOf;
        session.key = key;
        session.isStart = isStart;
        session.relTime = relTime;
        session.clusterSize = clusterSize;
        session.clusterStamp = clusterStamp;
        session.out = out;
        session.length = out[n];
        session.duration = durationMs / 1000;
        session.cues = cues.length;
    }

    /**
     * Байты перед данными блока: заголовок кластера (если блок его открывает)
     * и заголовок самого блока
     */
    function blockPrefix(session, j) {
        var parts = [];

        if (session.isStart[j]) {
            parts.push(ebmlId(ID.Cluster), vint(session.clusterSize[j], 8), bytes([0xE7, 0x84]), uint(session.clusterStamp[j], 4));
        }

        var head = alloc(BLOCK_HEAD);

        head[0] = 0xA3;
        vint(4 + session.size[j], 4).copy(head, 1);
        head[5] = 0x80 | session.track[j];
        head.writeInt16BE(session.relTime[j], 6);
        head[8] = session.key[j] ? 0x80 : 0x00;

        parts.push(head);

        return Buffer.concat(parts);
    }

    function prefixLength(session, j) {
        return (session.isStart[j] ? CLUSTER_HEAD : 0) + BLOCK_HEAD;
    }

    /**
     * Последний блок, начинающийся не позже position
     */
    function findBlock(session, position) {
        var lo = 0;
        var hi = session.count - 1;

        while (lo < hi) {
            var mid = (lo + hi + 1) >> 1;

            if (session.out[mid] <= position) lo = mid;
            else hi = mid - 1;
        }

        return lo;
    }

    // ------------------------------------------------------------------ сессии

    var sessions = [];

    function openSession(src, mode, done) {
        var id = mode + ' ' + src;

        for (var i = 0; i < sessions.length; i++) {
            if (sessions[i].id === id) {
                var found = sessions[i];

                sessions.splice(i, 1);
                sessions.unshift(found);

                if (found.ready) return done(found.error, found);

                found.waiting.push(done);

                return;
            }
        }

        var session = { id: id, src: src, mode: mode, ready: false, error: null, waiting: [done] };

        sessions.unshift(session);
        if (sessions.length > MAX_SESSIONS) sessions.pop();

        var started = Date.now();

        log('открываю', src);

        prepareSession(session, function (err) {
            session.ready = true;
            session.error = err || null;

            if (err) {
                log('ошибка:', err.message);

                // неудачную попытку не кэшируем: торрент мог просто не успеть скачаться
                var at = sessions.indexOf(session);

                if (at >= 0) sessions.splice(at, 1);
            }
            else {
                log('готово за', Date.now() - started, 'мс:', session.count, 'блоков,', session.cues, 'точек перемотки,', Math.round(session.duration), 'с');
            }

            var list = session.waiting;

            session.waiting = [];
            list.forEach(function (cb) { cb(session.error, session); });
        });
    }

    function prepareSession(session, done) {
        var src = session.src;
        var chunk = 256 * 1024;

        function readHead(length) {
            readRange(src, 0, length, function (err, buf, total) {
                if (err) return done(err);

                var header;

                try {
                    header = parseHeader(buf);
                }
                catch (e) {
                    return done(e);
                }

                if (!header) {
                    if (length >= 16 * 1024 * 1024 || buf.length < length) return done(new Error('не нашёл начало данных avi'));

                    return readHead(length * 4);
                }

                session.total = total || 0;

                if (!session.total) return done(new Error('источник не сообщил размер файла'));

                withHeader(header);
            });
        }

        function withHeader(header) {
            var tracks = [];
            var video = null;

            header.streams.forEach(function (stream) {
                if (stream.type === 'vids' && !video) {
                    video = describeVideo(stream, header);
                    tracks.push(video);
                }
            });

            if (!video) return done(new Error('в avi нет видеодорожки'));

            header.streams.forEach(function (stream) {
                if (stream.type === 'auds') tracks.push(describeAudio(stream));
            });

            var wanted = tracks.map(function (t) { return t.stream; });
            var openDml = wanted.every(function (number) {
                var indx = header.streams[number].indx;

                return indx && indx.length >= 24 && u32(indx, 4) > 0;
            });

            function withIndexes(err, indexes) {
                if (err) return done(err);

                // дорожки, у которых в индексе нет ни одного кадра, не объявляем
                tracks = tracks.filter(function (t) { return t.kind === 'video' || indexes[t.stream].count > 0; });

                if (!indexes[video.stream].count) return done(new Error('в индексе нет кадров видео'));

                if (video.asp && session.mode !== 'vfw' && !video.extra) {
                    return readVol(indexes, function () { finish(indexes); });
                }

                finish(indexes);
            }

            function readVol(indexes, next) {
                var index = indexes[video.stream];
                var first = -1;

                for (var i = 0; i < index.count; i++) {
                    if (index.size[i] > 0) { first = i; break; }
                }

                if (first < 0) return next();

                readRange(src, index.pos[first], Math.min(index.size[first], 65536), function (err, frame) {
                    if (!err) video.extra = extractVol(frame);

                    next();
                });
            }

            function finish(indexes) {
                try {
                    buildLayout(session, tracks, indexes, header.streams, session.mode);
                }
                catch (e) {
                    return done(e);
                }

                session.tracks = tracks;
                session.openDml = openDml;

                done(null);
            }

            if (openDml) readOpenDml(src, header.streams, wanted, withIndexes);
            else readIdx1(src, header, session.total, wanted, withIndexes);
        }

        readHead(chunk);
    }

    function describe(session) {
        return {
            ok: true,
            duration: session.duration,
            size: session.length,
            source: session.total,
            index: session.openDml ? 'opendml' : 'idx1',
            cues: session.cues,
            tracks: session.tracks.map(function (t) {
                if (t.kind === 'video') {
                    return { type: 'video', tag: t.tag, codec: t.asp && session.mode !== 'vfw' ? 'V_MPEG4/ISO/ASP' : 'V_MS/VFW/FOURCC', width: t.width, height: t.height, fps: Math.round(100 / t.frameSeconds) / 100, vol: Boolean(t.extra) };
                }

                return { type: 'audio', codec: t.codec, tag: t.tag, channels: t.channels, rate: t.rate, name: t.name };
            })
        };
    }

    // ------------------------------------------------------------------ отдача

    function parseRange(header, total) {
        var match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());

        if (!match) return null;

        var start;
        var end;

        if (match[1] === '') {
            var suffix = parseInt(match[2], 10);

            if (!suffix) return null;

            start = Math.max(0, total - suffix);
            end = total - 1;
        }
        else {
            start = parseInt(match[1], 10);
            end = match[2] === '' ? total - 1 : Math.min(parseInt(match[2], 10), total - 1);
        }

        if (start > end || start >= total) return { invalid: true };

        return { start: start, end: end };
    }

    /**
     * Отдаёт байты [start, end] виртуального файла
     */
    function streamRange(session, start, end, res) {
        var head = session.head;
        var outPos = start;

        if (outPos < head.length) {
            var headEnd = Math.min(end + 1, head.length);

            res.write(head.slice(outPos, headEnd));
            outPos = headEnd;
        }

        if (outPos > end) return res.end();

        var first = findBlock(session, outPos);
        var last = findBlock(session, end);
        var cur = first;
        var inBlock = outPos - session.out[first];

        // откуда и докуда читать исходный файл
        var firstPayload = Math.max(0, inBlock - prefixLength(session, first));
        var upStart = session.srcPos[first] + firstPayload;
        var lastPayloadBytes = end - session.out[last] - prefixLength(session, last) + 1;
        var upEnd = session.srcPos[last] + Math.min(session.size[last], Math.max(0, lastPayloadBytes)) - 1;

        var queue = [];
        var upPos = upStart;
        var upEnded = upEnd < upStart;
        var upstreamReq = null;
        var upstreamRes = null;
        var waitingDrain = false;
        var closed = false;

        function stop() {
            if (closed) return;
            closed = true;

            if (upstreamReq) {
                try { upstreamReq.abort(); } catch (e) {}
            }
        }

        function finish() {
            stop();
            res.end();
        }

        function pump() {
            while (!closed && !waitingDrain) {
                if (outPos > end || cur >= session.count) return finish();

                var plen = prefixLength(session, cur);

                if (inBlock < plen) {
                    var prefix = blockPrefix(session, cur).slice(inBlock, Math.min(plen, inBlock + (end - outPos + 1)));

                    inBlock += prefix.length;
                    outPos += prefix.length;

                    if (!res.write(prefix)) waitForDrain();

                    continue;
                }

                var payloadAt = inBlock - plen;
                var remain = Math.min(session.size[cur] - payloadAt, end - outPos + 1);

                if (remain <= 0) {
                    cur++;
                    inBlock = 0;
                    continue;
                }

                var want = session.srcPos[cur] + payloadAt;

                // пропускаем промежутки между кадрами: заголовки чанков, JUNK, чужие потоки
                while (upPos < want && queue.length) {
                    var skip = Math.min(want - upPos, queue[0].length);

                    queue[0] = queue[0].slice(skip);
                    upPos += skip;

                    if (!queue[0].length) queue.shift();
                }

                if (upPos < want || !queue.length) {
                    if (upEnded) return finish();
                    if (upstreamRes && upstreamRes.isPaused && upstreamRes.isPaused()) upstreamRes.resume();

                    return;
                }

                var piece = queue[0];
                var take = Math.min(piece.length, remain);
                var out = piece.slice(0, take);

                queue[0] = piece.slice(take);
                if (!queue[0].length) queue.shift();

                upPos += take;
                inBlock += take;
                outPos += take;

                if (!res.write(out)) waitForDrain();
            }
        }

        function waitForDrain() {
            waitingDrain = true;

            if (upstreamRes) upstreamRes.pause();

            res.once('drain', function () {
                waitingDrain = false;
                pump();
            });
        }

        res.on('close', stop);

        if (upEnded) return pump();

        upstreamReq = requestUpstream(session.src, { Range: 'bytes=' + upStart + '-' + upEnd }, function (err, upRes, req) {
            if (closed) {
                if (upRes) upRes.resume();
                return;
            }

            if (err) {
                log('обрыв источника:', err.message);
                return finish();
            }

            upstreamReq = req;
            upstreamRes = upRes;

            if (upRes.statusCode !== 206) {
                log('источник ответил', upRes.statusCode, 'на диапазон', upStart + '-' + upEnd);

                // без поддержки Range придётся пропустить начало файла вручную
                if (upRes.statusCode === 200) upPos = 0;
                else return finish();
            }

            upRes.on('data', function (chunk) {
                if (closed) return;

                queue.push(chunk);

                // не копим лишнего, пока плеер не забрал предыдущее
                if (waitingDrain) upRes.pause();

                pump();
            });

            // источник может оборваться без end (таймаут, остановка торрента): тогда
            // отдаём, что есть, и закрываем ответ, плеер перезапросит с нужного места
            ['end', 'error', 'aborted', 'close'].forEach(function (event) {
                upRes.on(event, function () {
                    upEnded = true;
                    pump();
                });
            });
        });
    }

    function sendJson(res, code, data) {
        res.writeHead(code, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store'
        });
        res.end(JSON.stringify(data));
    }

    function handle(req, res) {
        var parsed = urlLib.parse(req.url, true);
        var path = parsed.pathname || '/';
        var query = parsed.query || {};
        var mode = query.mode === 'vfw' ? 'vfw' : 'asp';

        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Range',
                'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS'
            });

            return res.end();
        }

        if (path === '/health') {
            return sendJson(res, 200, { ok: true, service: 'lampa-avi', version: VERSION, sessions: sessions.length });
        }

        if (path === '/log') {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });

            return res.end(journal.join('\n'));
        }

        if (!query.url) return sendJson(res, 400, { ok: false, error: 'нет параметра url' });

        if (path === '/open') {
            return openSession(query.url, mode, function (err, session) {
                if (err) return sendJson(res, 502, { ok: false, error: err.message });

                sendJson(res, 200, describe(session));
            });
        }

        if (path.indexOf('/mkv') === 0) {
            return openSession(query.url, mode, function (err, session) {
                if (err) {
                    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });

                    return res.end(err.message);
                }

                var total = session.length;
                var range = parseRange(req.headers.range, total);
                var headers = {
                    'Content-Type': 'video/x-matroska',
                    'Accept-Ranges': 'bytes',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-cache'
                };

                if (range && range.invalid) {
                    headers['Content-Range'] = 'bytes */' + total;
                    res.writeHead(416, headers);

                    return res.end();
                }

                var start = range ? range.start : 0;
                var end = range ? range.end : total - 1;

                headers['Content-Length'] = String(end - start + 1);

                if (range) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + total;

                res.writeHead(range ? 206 : 200, headers);

                if (req.method === 'HEAD') return res.end();

                streamRange(session, start, end, res);
            });
        }

        sendJson(res, 404, { ok: false, error: 'нет такого адреса' });
    }

    function start(port, host) {
        var server = http.createServer(function (req, res) {
            try {
                handle(req, res);
            }
            catch (e) {
                log('сбой обработки:', e && e.stack ? e.stack : e);

                try {
                    res.writeHead(500);
                    res.end();
                }
                catch (e2) {}
            }
        });

        server.on('error', function (e) {
            log('не удалось занять порт', port + ':', e.message);
        });

        server.listen(port || DEFAULT_PORT, host || '127.0.0.1', function () {
            log('lampa-avi', VERSION, 'слушает', (host || '127.0.0.1') + ':' + (port || DEFAULT_PORT));
        });

        return server;
    }

    var api = {
        VERSION: VERSION,
        start: start,
        openSession: openSession,
        parseHeader: parseHeader,
        extractVol: extractVol,
        vint: vint
    };

    var isMain = typeof require !== 'undefined' && require.main && typeof module !== 'undefined' && require.main === module;

    if (isMain) {
        var args = process.argv.slice(2);

        start(parseInt(args[0], 10) || DEFAULT_PORT, args[1] || '127.0.0.1');
    }
    else if (typeof module !== 'undefined' && module.exports && typeof tizen === 'undefined') {
        // подключён из тестов
        module.exports = api;
    }
    else {
        // запуск сервисом TizenBrew: у него свой module, а tizen есть в глобальной области
        start(DEFAULT_PORT, '127.0.0.1');

        if (typeof module !== 'undefined') module.exports = api;
    }
})();
