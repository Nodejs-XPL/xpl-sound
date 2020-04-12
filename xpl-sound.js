/*jslint node: true, vars: true, nomen: true, esversion: 6 */
'use strict';

const Xpl = require("xpl-api");
const commander = require('commander');
const SoundPlayer = require('soundplayer');
const os = require('os');
const fs = require('fs');
const Path = require('path');
const loudness = require('loudness');
const debug = require('debug')('xpl-sound');
const Semaphore = require('semaphore');
const textToSpeech = require('@google-cloud/text-to-speech');
const tmp = require('tmp');
const crypto = require('crypto');

const DEFAULT_DEVICE_NAME = "soundplayer";

commander.version(require("./package.json").version);

commander.option("--heapDump", "Enable heap dump (require heapdump)");
commander.option("--minimumDelayBetweenProgress", "Minimum delay between two progress events (seconds)", parseFloat);
commander.option("--volumeStateDelay", "Volume and mute state interval", parseInt);
commander.option("--deviceName <name>", "Device name");
commander.option("--soundsRepository <directory>", "Sounds repository");
commander.option("--ttsCacheDir <directory>", "TTS cache directory");

Xpl.fillCommander(commander);

var mainTrackList = [];

commander.command('*').description("Start waiting sound commands").action(() => {
	console.log("Start");

	let hostName = os.hostname();
	if (hostName.indexOf('.') > 0) {
		hostName = hostName.substring(0, hostName.indexOf('.'));
	}

	let deviceName = commander.deviceName;
	if (!deviceName) {
		deviceName = DEFAULT_DEVICE_NAME + "-" + hostName;
	}

	if (!commander.xplSource) {
		commander.xplSource = "soundplayer." + hostName;
	}

	var xpl = new Xpl(commander);

	xpl.on("error", (error) => {
		console.error("XPL error", error);
	});

	xpl.bind((error) => {
		if (error) {
			console.log("Can not open xpl bridge ", error);
			process.exit(2);
			return;
		}

		console.log("Xpl bind succeed ");
		// xpl.sendXplTrig(body, callback);

		var timer = 5;
		if (commander.volumeStateDelay !== undefined) {
			timer = commander.volumeStateDelay;
		}

		if (timer > 0) {
			setInterval(updateLoudnessChanges.bind(this, xpl, deviceName), 1000 * timer);
		}

		let ttsClient;
		try {
			ttsClient = new textToSpeech.TextToSpeechClient();
		} catch (x) {
			console.error(x);
		}

		var soundPlayer = new SoundPlayer(commander);

		xpl.on("xpl:xpl-cmnd", (message) => {
			debug("XplMessage", message);

			const body = message.body;


			if (message.bodyName === 'audio.tts' && ttsClient) {
				switch (body.command) {
					case "speech":
						let text = body.message;
						if (!text) {
							console.error("No specified text", body);
							return;
						}
						let languageCode = body.languageCode || 'fr-FR';
						let ssmlGender = body.ssmlGender || 'NEUTRAL';
						playTTS(ttsClient, soundPlayer, xpl, text.trim(), languageCode, ssmlGender, body.uuid, deviceName);
						return;
				}
				return;
			}

			if (message.bodyName !== "audio.basic") {
				return;
			}

//			console.log('Process message=', body);

			switch (body.command) {
				case "play":
					let url = body.url || body.current;
					if (!url) {
						console.error("No specified url", body);
						return;
					}
					let path = url;
					const reg = /^#(.*)$/.exec(url);
					if (reg && commander.soundsRepository) {
						const p = Path.join(commander.soundsRepository, reg[1] + '.mp3');
//						console.log('Path=', p);
						if (fs.existsSync(p)) {
							path = Path.resolve(p);
						}
					}
//					console.log('=> url=', url, 'path=', path, commander.soundsRepository, reg);
					playSound(soundPlayer, xpl, url, path, body.uuid, (body.inTrackList === "enable") ? mainTrackList : null, deviceName);
					return;

				case "volume+":
					changeVolume(xpl, 1, deviceName);
					return;

				case "volume-":
					changeVolume(xpl, -1, deviceName);
					return;

				case "mute":
					changeMute(xpl, true, deviceName);
					return;

				case "unmute":
					changeMute(xpl, false, deviceName);
					return;
			}
		});
	});
});

var updateLock = Semaphore(1);

const ttsToFile = {};

function playTTS(ttsClient, soundPlayer, xpl, text, languageCode, ssmlGender, uuid, deviceName) {
	const request = {
		input: {text},
		voice: {languageCode, ssmlGender},
		audioConfig: {audioEncoding: 'MP3'},
	};

	const shasum = crypto.createHash('sha1');
	shasum.update(JSON.stringify(request));
	const key = shasum.digest('hex') + '.mp3';

	debug('playTTS', 'key=', key, 'request=', request);

	let ttsPath;
	if (commander.ttsCacheDir) {
		ttsPath = Path.join(commander.ttsCacheDir, key);

		if (fs.existsSync(ttsPath)) {
			playSound(soundPlayer, xpl, "tts:" + text, ttsPath, uuid, null, deviceName);
			return;
		}
	}

	const alreadyFilePath = ttsToFile[key];
	if (alreadyFilePath) {
		playSound(soundPlayer, xpl, "tts:" + text, alreadyFilePath, uuid, null, deviceName);
		return;
	}

	ttsClient.synthesizeSpeech(request).then((result) => {
		debug('playTTS', 'SynthesizeSpeech Result=', result);

		const [response] = result;

		if (ttsPath) {
			fs.writeFile(ttsPath, response.audioContent, 'binary', (error) => {
				if (error) {
					console.error(error);
					return;
				}
				playSound(soundPlayer, xpl, "tts:" + text, ttsPath, uuid, null, deviceName);
			});
			return;
		}

		tmp.file({prefix: 'tts-', postfix: '.mp3'}, (error, path) => {
			fs.writeFile(path, response.audioContent, 'binary', (error) => {
				if (error) {
					console.error(error);
					return;
				}
				ttsToFile[key] = path;

				playSound(soundPlayer, xpl, "tts:" + text, path, uuid, null, deviceName);
			});
		});

	}, (error) => {
		console.error(error);
	})

}

function changeMute(xpl, mute, deviceName) {
	debug("Change mute to ", mute);

	updateLock.take(function () {
		loudness.setMuted(mute, function (error) {
			updateLock.leave();
			if (error) {
				console.error("Can not set muted error=", error);
				return;
			}

			updateLoudnessChanges(xpl, deviceName);
		});
	});
}

function changeVolume(xpl, increment, deviceName) {
	debug("Change volume to ", increment);

	updateLock.take(() => {
		loudness.getVolume((error, volume) => {
			if (error) {
				updateLock.leave();
				console.error("Can not get volume error=", error);
				return;
			}

			loudness.setVolume(volume + increment, function (error) {
				updateLock.leave();

				if (error) {
					console.error("Can not set volume error=", error);
					return;
				}

				updateLoudnessChanges(xpl, deviceName);
			});
		});
	});
}

var lastVolume;
var lastMuted;

function updateLoudnessChanges(xpl, deviceName) {
	debug("updateLoudnessChanges", "Start update");

	function updateMute() {
		loudness.getMuted((error, mute) => {
			debug("getMuted() returns", mute, error);

			if (error) {
				console.error("Can not get muted error=", error);
				updateLock.leave();
				return;
			}

			if (mute === lastMuted) {
				updateLock.leave();
				return;
			}
			lastMuted = mute;

			xpl.sendXplTrig({
				device: deviceName,
				type: 'muted',
				command: !!mute

			}, "audio.basic", function (error) {
				if (error) {
					console.error("Can not send xpl message error=", error);
				}
				updateLock.leave();
			});
		});
	}

	updateLock.take(() => {
		loudness.getVolume((error, volume) => {
			debug("getVolume() returns", volume, error);
			if (error) {
				console.error("Can not get volume error=", error);
				return updateMute();
			}

			if (volume === lastVolume) {
				return updateMute();
			}
			lastVolume = volume;

			xpl.sendXplTrig({
				device: deviceName,
				type: 'volume',
				command: volume
			}, "audio.basic", function (error) {
				if (error) {
					console.error("Can not send xpl message error=", error);
				}

				updateMute();
			});
		});
	});
}

var trackList = [];

function playSound(soundPlayer, xpl, url, path, uuid, trackList, deviceName) {
	debug("playSound", "Play sound url=", url);
	var sound = soundPlayer.newSound(path, uuid);
	sound._url = url;

	if (trackList) {
		trackList.push(sound);

		debug("Track list=", trackList);
		if (trackList.length > 1) {
			return;
		}
	}

	playSound1(soundPlayer, xpl, sound, deviceName, trackList);
}


function playSound1(soundPlayer, xpl, sound, deviceName, trackList) {

	function onPlaying() {
		xpl.sendXplTrig({
			device: deviceName,
			url: sound._url,
			command: 'playing',
			uuid: sound.uuid
		}, "audio.basic");
	}

	function onProgress(progress) {
		var d = {
			device: deviceName,
			url: sound._url,
			command: 'progress',
			uuid: sound.uuid
		};
		for (var i in progress) {
			d[i] = progress[i];
		}
		xpl.sendXplTrig(d, "audio.basic");
	}

	function onStopped() {
		sound.removeListener('playing', onPlaying);
		sound.removeListener('progress', onProgress);
		sound.removeListener('error', onError);
		xpl.removeListener('xpl:xpl-cmnd', onXplStop);

		xpl.sendXplTrig({
			device: deviceName,
			uuid: sound.uuid,
			url: sound._url,
			command: 'stop'
		}, "audio.basic");

		if (trackList) {
			trackList.shift();

			if (trackList[0]) {
				playSound1(soundPlayer, xpl, trackList[0], deviceName, trackList);
			}
		}
	}

	function onError(error) {
		console.error(error);
		sound.removeListener('playing', onPlaying);
		sound.removeListener('progress', onProgress);
		sound.removeListener('stopped', onStopped);
		xpl.removeListener('xpl:xpl-cmnd', onXplStop);

		xpl.sendXplTrig({
			device: deviveName,
			url: sound.url,
			command: 'error',
			uuid: sound.uuid
		}, "audio.basic");

		if (trackList) {
			trackList.shift();

			if (trackList[0]) {
				playSound1(soundPlayer, xpl, trackList[0]);
			}
		}
	}

	function onXplStop(message) {
		if (message.bodyName !== "audio.basic" || message.body.command !== 'stop') {
			return;
		}

		if (message.body.uuid && message.body.uuid !== sound.uuid) {
			return;
		}

		if (message.body.url && message.body.url !== sound.url) {
			return;
		}

		if (trackList) {
			for (; trackList.length;) {
				trackList.shift();
			}
		}
		sound.stop();
	}

	sound.once('playing', onPlaying);
	sound.on('progress', onProgress);
	sound.once('stopped', onStopped);
	sound.once('error', onError);
	xpl.on("xpl:xpl-cmnd", onXplStop);

	sound.play();
}

commander.parse(process.argv);

if (commander.headDump) {
	var heapdump = require("heapdump");
	console.log("***** HEAPDUMP enabled **************");
}
