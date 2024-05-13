"use strict";
var mierucaHmAbTest = function () {

    var HOST = "ntjp.mieru-ca.com",
    PATH = "/abtest",
    MIERUCA_HM_AB_TEST_COOKIE_KEY = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    webSocket = null,
    isWebSocketActive = false,
    device = null,
    siteId = window.__fid[0][0],
    referrer_url= document.referrer,
    local_url = window.location.href;


    this.init = function () {
        device = getDeviceType();
        this.setUpWebSocket();
        var prevTestPattern = getPrevTestPatternFromCookieValue();
    };

    this.setUpWebSocket = function () {
        webSocket = createWebSocketObject();
        setAttributesToWebSocket();
    };

    var createWebSocketObject = function () {
        var protocol = document.location.protocol === 'https:' ? 'wss' : 'ws',
        endpoint = protocol + "://" + HOST + PATH;
        return new WebSocket(endpoint);
    };

    var setAttributesToWebSocket = function () {
        webSocket.onopen = function () {
            isWebSocketActive = true;
            (function () {
                var checkVisitor = {};
                checkVisitor["type"] = 'cv';
                checkVisitor["sId"] = siteId;
                checkVisitor["url"] = local_url;
                checkVisitor["d"] = device;
                checkVisitor["refUrl"] = referrer_url;
                webSocket.sendMessage(JSON.stringify(checkVisitor));
            })();
        };
        webSocket.onclose = function () {
            isWebSocketActive = false;
        };
        webSocket.sendMessage = function (data) {
            if (!isWebSocketActive || data === '') {
                return;
            }
            if (this.readyState === this.OPEN) {
                this.send(data);
            }
        };
        webSocket.onmessage = function(event) {
            if(event.data instanceof String){
                //create a JSON object
                var data = JSON.parse(event.data),
                isTarget = data.isTarget,
                patternUrl = data.patternUrl;
                if (isTarget) {
                    redirectSite(patternUrl);
                }
            }
        };
    };

    var redirectSite = function (patternUrl) {
        window.location.replace(patternUrl);
    }

    var getDeviceType = function () {
        var mobilePattern = /Mobile|iP(hone|od)|Android|BlackBerry|IEMobile|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/,
            tabletPattern = /(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i,
            userAgent = navigator.userAgent;
        if (mobilePattern.test(userAgent)) {
            return "m";
        }
        if (tabletPattern.test(userAgent)) {
            return "t";
        }
        return "d";
    }

    var getPrevTestPatternFromCookieValue = function () {
        var cookieValue = document.cookie,
            cookieValueMap = cookieValue.split(';').map(v => v.split('=')).reduce((m, v) => {
            var key = v[0].trim();
            m[key] = v[1].trim(); // TODO: understand `reduce` work
        }, new Map());
        return cookieValueMap[MIERUCA_HM_AB_TEST_COOKIE_KEY];
    };
};

(function () {
    window.__mieruca_heatmap_ab_test = new mierucaHmAbTest();
    window.__mieruca_heatmap_ab_test.init();
}());