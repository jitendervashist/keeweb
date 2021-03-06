'use strict';

var StorageBase = require('./storage-base');

var StorageWebDav = StorageBase.extend({
    name: 'webdav',
    icon: 'server',
    enabled: true,
    uipos: 10,

    needShowOpenConfig: function() {
        return true;
    },

    getOpenConfig: function() {
        return {
            fields: [
                {id: 'path', title: 'openUrl', desc: 'openUrlDesc', type: 'text', required: true},
                {id: 'user', title: 'openUser', desc: 'openUserDesc', placeholder: 'openUserPlaceholder', type: 'text'},
                {id: 'password', title: 'openPass', desc: 'openPassDesc', placeholder: 'openPassPlaceholder', type: 'password'}
            ]
        };
    },

    load: function(path, opts, callback) {
        this._request({
            op: 'Load',
            method: 'GET',
            path: path,
            user: opts ? opts.user : null,
            password: opts ? opts.password : null
        }, callback ? (err, xhr, stat) => {
            callback(err, xhr.response, stat);
        } : null);
    },

    stat: function(path, opts, callback) {
        this._request({
            op: 'Stat',
            method: 'HEAD',
            path: path,
            user: opts ? opts.user : null,
            password: opts ? opts.password : null
        }, callback ? (err, xhr, stat) => {
            callback(err, stat);
        } : null);
    },

    save: function(path, opts, data, callback, rev) {
        var cb = function(err, xhr, stat) {
            if (callback) {
                callback(err, stat);
                callback = null;
            }
        };
        var tmpPath = path.replace(/[^\/]+$/, m => '.' + m) + '.' + Date.now();
        var saveOpts = {
            path: path,
            user: opts ? opts.user : null,
            password: opts ? opts.password : null
        };
        var that = this;
        this._request(_.defaults({
            op: 'Save:stat', method: 'HEAD'
        }, saveOpts), (err, xhr, stat) => {
            if (err) { return cb(err); }
            if (stat.rev !== rev) {
                that.logger.debug('Save error', path, 'rev conflict', stat.rev, rev);
                return cb({ revConflict: true }, xhr, stat);
            }
            that._request(_.defaults({
                op: 'Save:put', method: 'PUT', path: tmpPath, data: data, nostat: true
            }, saveOpts), (err) => {
                if (err) { return cb(err); }
                that._request(_.defaults({
                    op: 'Save:stat', method: 'HEAD'
                }, saveOpts), (err, xhr, stat) => {
                    if (err) {
                        that._request(_.defaults({ op: 'Save:delete', method: 'DELETE', path: tmpPath }, saveOpts));
                        return cb(err, xhr, stat);
                    }
                    if (stat.rev !== rev) {
                        that.logger.debug('Save error', path, 'rev conflict', stat.rev, rev);
                        that._request(_.defaults({ op: 'Save:delete', method: 'DELETE', path: tmpPath }, saveOpts));
                        return cb({ revConflict: true }, xhr, stat);
                    }
                    var movePath = path;
                    if (movePath.indexOf('://') < 0) {
                        movePath = location.href.replace(/[^/]*$/, movePath);
                    }
                    that._request(_.defaults({
                        op: 'Save:move', method: 'MOVE', path: tmpPath, nostat: true,
                        headers: { Destination: movePath, 'Overwrite': 'T' }
                    }, saveOpts), (err) => {
                        if (err) { return cb(err); }
                        that._request(_.defaults({
                            op: 'Save:stat', method: 'HEAD'
                        }, saveOpts), (err, xhr, stat) => {
                            cb(err, xhr, stat);
                        });
                    });
                });
            });
        });
    },

    fileOptsToStoreOpts: function(opts, file) {
        var result = {user: opts.user, encpass: opts.encpass};
        if (opts.password) {
            var fileId = file.get('uuid');
            var password = opts.password;
            var encpass = '';
            for (var i = 0; i < password.length; i++) {
                encpass += String.fromCharCode(password.charCodeAt(i) ^ fileId.charCodeAt(i % fileId.length));
            }
            result.encpass = btoa(encpass);
        }
        return result;
    },

    storeOptsToFileOpts: function(opts, file) {
        var result = {user: opts.user, password: opts.password};
        if (opts.encpass) {
            var fileId = file.get('uuid');
            var encpass = atob(opts.encpass);
            var password = '';
            for (var i = 0; i < encpass.length; i++) {
                password += String.fromCharCode(encpass.charCodeAt(i) ^ fileId.charCodeAt(i % fileId.length));
            }
            result.password = password;
        }
        return result;
    },

    _request: function(config, callback) {
        var that = this;
        if (config.rev) {
            that.logger.debug(config.op, config.path, config.rev);
        } else {
            that.logger.debug(config.op, config.path);
        }
        var ts = that.logger.ts();
        var xhr = new XMLHttpRequest();
        xhr.addEventListener('load', () => {
            if ([200, 201, 204].indexOf(xhr.status) < 0) {
                that.logger.debug(config.op + ' error', config.path, xhr.status, that.logger.ts(ts));
                var err;
                switch (xhr.status) {
                    case 404:
                        err = { notFound: true };
                        break;
                    case 412:
                        err = { revConflict: true };
                        break;
                    default:
                        err = 'HTTP status ' + xhr.status;
                        break;
                }
                if (callback) { callback(err, xhr); callback = null; }
                return;
            }
            var rev = xhr.getResponseHeader('Last-Modified');
            if (!rev && !config.nostat) {
                that.logger.debug(config.op + ' error', config.path, 'no headers', that.logger.ts(ts));
                if (callback) { callback('No Last-Modified header', xhr); callback = null; }
                return;
            }
            var completedOpName = config.op + (config.op.charAt(config.op.length - 1) === 'e' ? 'd' : 'ed');
            that.logger.debug(completedOpName, config.path, rev, that.logger.ts(ts));
            if (callback) { callback(null, xhr, rev ? { rev: rev } : null); callback = null; }
        });
        xhr.addEventListener('error', () => {
            that.logger.debug(config.op + ' error', config.path, that.logger.ts(ts));
            if (callback) { callback('network error', xhr); callback = null; }
        });
        xhr.addEventListener('abort', () => {
            that.logger.debug(config.op + ' error', config.path, 'aborted', that.logger.ts(ts));
            if (callback) { callback('aborted', xhr); callback = null; }
        });
        xhr.open(config.method, config.path);
        xhr.responseType = 'arraybuffer';
        if (config.user) {
            xhr.setRequestHeader('Authorization', 'Basic ' + btoa(config.user + ':' + config.password));
        }
        if (config.headers) {
            _.forEach(config.headers, (value, header) => {
                xhr.setRequestHeader(header, value);
            });
        }
        if (['GET', 'HEAD'].indexOf(config.method) >= 0) {
            xhr.setRequestHeader('Cache-Control', 'no-cache');
        }
        if (config.data) {
            var blob = new Blob([config.data], {type: 'application/octet-stream'});
            xhr.send(blob);
        } else {
            xhr.send();
        }
    }
});

module.exports = new StorageWebDav();
