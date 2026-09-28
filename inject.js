/**
 * Скрипт, который TizenBrew вставляет в страницу Lampa.
 *
 * Дожидается загрузки Lampa и подключает общий плагин p.js: в нём подмена ссылок
 * на avi (плеер пойдёт через сервис этого модуля на http://127.0.0.1:8898) и
 * остальные доработки. Если тот же плагин уже добавлен в самой Lampa через
 * Расширения, второй раз он не запустится: каждая доработка защищена флагом.
 */
(function () {
    'use strict';

    if (window.lampa_avi_inject) return;
    window.lampa_avi_inject = true;

    var PLUGIN = 'https://l.iphub.io/p.js';
    var tries = 0;

    function add() {
        if (!window.Lampa || !document.body) {
            if (tries++ < 240) setTimeout(add, 500);

            return;
        }

        var script = document.createElement('script');

        script.src = PLUGIN;
        document.body.appendChild(script);
    }

    add();
})();
