var Xpl = require("xpl-api");
var commander = require('commander');
var SoundPlayer = require('soundplayer');
var os = require('os');
var debug = require('debug')('xpl-sound');

commander.version(require("./package.json").version);

commander.option("--heapDump", "Enable heap dump (require heapdump)");

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
        console.log("XPL error", error);
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

            playSound(xpl, url);

            return;
          }
        });
      });
    });

function playSound(xpl, url) {
  debug("Play sound ", url);
  var sound = soundPlayer.newSound(url);
  sound.once('playing', function onPlaying() {
    xpl.sendXplTrig({
      uuid : sound.uuid,
      url : sound.url,
      command : 'playing'
    }, "audio.basic");
  });
  sound.on('progress', function onProgress(progress) {
    var d = {
      uuid : sound.uuid,
      url : sound.url,
      command : 'progress'
    };
    for ( var i in progress) {
      d[i] = progress[i];
    }
    xpl.sendXplTrig(d, "audio.basic");
  });
  sound.once('stopped', function onStopped() {
    sound.removeListener('playing', onPlaying);
    sound.removeListener('progress', onProgress);
    sound.removeListener('error', onError);
    xpl.removeListener('xpl:xpl-cmnd', onStop);

    xpl.sendXplTrig({
      uuid : sound.uuid,
      url : sound.url,
      command : 'stop'
    }, "audio.basic");
  });
  sound.once('error', function onStopped() {
    sound.removeListener('playing', onPlaying);
    sound.removeListener('progress', onProgress);
    sound.removeListener('stopped', onStopped);
    xpl.removeListener('xpl:xpl-cmnd', onStop);

    xpl.sendXplTrig({
      uuid : sound.uuid,
      url : sound.url,
      command : 'error'
    }, "audio.basic");
  });
  xpl.on("xpl:xpl-cmnd", function onStop(message) {
    if (message.bodyName !== "audio.basic" || message.body.command !== 'stop') {
      return;
    }

    if (message.body.uuid !== sound.uuid) {
      return;
    }

    sound.stop();
  });

  sound.play();
}

commander.parse(process.argv);

if (commander.headDump) {
  var heapdump = require("heapdump");
  console.log("***** HEAPDUMP enabled **************");
}
