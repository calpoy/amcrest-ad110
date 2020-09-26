const events = require('events');
const got = require('got/dist/source');
const Auth = require('http-auth-client')

const ATTACH_PATH = '/cgi-bin/eventManager.cgi?action=attach&codes=[All]';
const TIME_PATH = '/cgi-bin/globalglobal.cgi?action=getCurrentTime';

const RETRY_DELAY = 60000;

class AD110Monitor {
    constructor(config) {
        if (config.ipAddr == undefined) throw 'No ipAddr defined';
        if (config.password == undefined) throw 'No password defined';

        this.ipAddr = config.ipAddr;
        this.password = config.password;

        this.retryDelay = config.retryDelay || RETRY_DELAY;

        this.emitter = new events.EventEmitter();
        this.running = false;

        this.listener = null;
        this.auth = null;

        this.process = (code) => {
            switch (code) {
                case 'AlarmLocal': {
                    code.code = 'Motion';
                }
                case '_DoTalkAction_': {
                    code = code.data;
                    code.action = code.Action;
                    delete code.Action;

                    this.emitter.emit(code.action, code);
                }
                case 'CallNoAnswered': {
                    code.action = 'CallNotAnswered';
                }
            }

            this.emitter.emit(code.action, code);
            this.emitter.emit('*', code);
        };

        this.attach = () => {
            this.isAlive()
                .then(alive => {
                    if (!alive) {
                        this.emitter.emit('error', 'AD110 Not Found');
                    } else {
                        this.listener = got(`http://${this.ipAddr}${ATTACH_PATH}`, {
                            headers: { 'Authorization': this.auth }
                        });

                        this.listener
                            .on('response', res => {
                                res.on('data', data => {
                                    var lines = Buffer.from(data).toString().split('\n');
                                    var midCode = false, al;

                                    lines.forEach(l => {
                                        if (l.startsWith('Code')) {
                                            if (l.includes('data={')) {
                                                al = l;
                                                midCode = true;
                                            } else {
                                                this.process(JSON.parse(`{"${l.replace(/=/g, '":"').replace(/;/g, '","').replace(/\r/g, '')}"}`));
                                            }
                                        } else if (midCode) {
                                            al += l;

                                            if (l.startsWith('}')) {
                                                try {
                                                    const idx = al.indexOf(';data=');
                                                    var code = al.substring(0, idx);
                                                    var data = al.substring(idx + 6);

                                                    var code = JSON.parse(`{"${code.replace(/=/g, '":"').replace(/;/g, '","').replace(/\r/g, '')}"}`)
                                                    code.data = JSON.parse(data);

                                                    this.process(code);
                                                } catch (err) {
                                                    this.emitter.emit('error', err);
                                                }
                                                this.midCode = false;
                                            }
                                        }
                                    });
                                });
                            })
                            .catch(err => {
                                if (!err.isCanceled) {
                                    if (err.response && err.response.statusCode) {
                                        if (err.response.statusCode == 401) {
                                            this.emitter.emit('error', 'Unauthorized Access');
                                        }
                                    }
                                    else {
                                        this.emitter.emit('error', JSON.stringify(err));
                                    }
                                } else {
                                    this.listener = null;
                                }

                                this.auth = null;
                            })
                            .finally(_ => {
                                if (this.running) {
                                    setTimeout(_ => {
                                        if (this.running) {
                                            this.attach();
                                        }
                                    }, this.retryDelay);
                                }
                            });
                    }
                });
        }
    }

    isAlive() {
        return new Promise((res, rej) => {
            got(`http://${this.ipAddr}${TIME_PATH}`)
                .catch(errRes => {
                    if (errRes.response.statusCode == 401) {
                        var challenges = Auth.parseHeaders(errRes.response.headers['www-authenticate']);
                        var auth = Auth.create(challenges);

                        auth.credentials('admin', this.password);

                        this.auth = auth.authorization("GET", ATTACH_PATH)

                        res(true);
                    } else {
                        res(false);
                    }
                });
        });
    }


    start() {
        if (!this.running) {
            this.running = true;
            this.attach();
        }
    }

    stop() {
        this.running = false;

        if (this.listener) {
            this.listener.cancel();
        }
    }


    listen(listener) {
        this.emitter.addListener('*', listener);
    }

    unlisten() {
        this.emitter.removeAllListeners();
    }


    onMotion(listener) { //alarmlocal
        this.emitter.addListener('Motion', listener);
    }

    onVideoMotion(listener) { //videomotion
        this.emitter.addListener('VideoMotion', listener);
    }

    onVideoBlindStart(listener) { //videoblind
        this.emitter.addListener('VideoBlind', listener);
    }

    onDoorbellButtonPress(listener) { //_DoTalkAction_ : Invite
        this.emitter.addListener('Invite', listener);
    }

    onDoorbellAnswer(listener) { //?
        this.emitter.addListener('Answer', listener);
    }

    onDoorbellHangup(listener) { //_DoTalkAction_ : Hangup
        this.emitter.addListener('Hangup', listener);
    }

    onCallNotAnswered(listener) { //CallNoAnswered
        this.emitter.addListener('CallNotAnswered', listener);
    }


}


module.exports = AD110Monitor;