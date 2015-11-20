var Xpl = require("xpl-api");
var commander = require('commander');
var SoundPlayer = require('soundplayer');
var os = require('os');
var debug = require('debug')('xpl-sound');

commander.version(require("./package.json").version);

commander.option("--heapDump", "Enable heap dump (require heapdump)");
commander.option("--minimumDelayBetweenProgress",
    "Minimum delay between two progress events (seconds)", parseFloat);

Xpl.fillCommander(commander);

commander.command('*').description("Start waiting sound commands").action(
    function() {
      console.log("Start");

      if (!commander.xplSource) {
        var hostName = os.hostname();
        if (hostName.indexOf('.') > 0) {
          hostName = hostName.substring(0, hostName.indexOf('.'));
        }

        commander.xplSource = "soundplayer." + hostName;
      }

      var xpl = new Xpl(commander);

      xpl.on("error", function(error) {
        console.error("XPL error", error);
      });

      xpl.bind(function(error) {
        if (error) {
          console.log("Can not open xpl bridge ", error);
          process.exit(2);
          return;
        }

        console.log("Xpl bind succeed ");
        // xpl.sendXplTrig(body, callback);

        var soundPlayer = new SoundPlayer(commander);

        xpl.on("xpl:xpl-cmnd", function(message) {
          debug("XplMessage", message);
          if (message.bodyName !== "audio.basic") {
            return;
          }

          var body = message.body;

          if (body.command === "play") {
            var url = body.url;
            if (!url) {
              console.error("No specified url", body);
              return;
            }

            playSound(soundPlayer, xpl, url);

            return;
          }
        });
      });
    });

function playSound(soundPlayer, xpl, url) {
  debug("Play sound ", url);
  var sound = soundPlayer.newSound(url);

  function onPlaying() {
    xpl.sendXplTrig({
      url : sound.url,
      command : 'playing',
      uuid : sound.uuid
    }, "audio.basic");
  }
  function onProgress(progress) {
    var d = {
      url : sound.url,
      command : 'progress',
      uuid : sound.uuid
    };
    for ( var i in progress) {
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
      uuid : sound.uuid,
      url : sound.url,
      command : 'stop'
    }, "audio.basic");
  }
  function onError() {
    sound.removeListener('playing', onPlaying);
    sound.removeListener('progress', onProgress);
    sound.removeListener('stopped', onStopped);
    xpl.removeListener('xpl:xpl-cmnd', onXplStop);

    xpl.sendXplTrig({
      url : sound.url,
      command : 'error',
      uuid : sound.uuid
    }, "audio.basic");
  }
  function onXplStop(message) {
    if (message.bodyName !== "audio.basic" || message.body.command !== 'stop') {
      return;
    }

    if (message.body.uuid !== sound.uuid && message.body.url !== sound.url) {
      return;
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
