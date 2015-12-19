var debug = 0;
var showCalls = 0;
var showSystemCalls = 0;

var instCount = 0;

var currentProcessId = 0;
var processes = [];

function myLoop() {
	var busy = false;
	for (var i = 0; i < processes.length; ++i) {
		var p = processes[i];
		if (p.exited)
			continue;
		currentProcessId = i;
		var ticks = 0;
		// Beware: there is a significant performance penalty for re-scheduling.
		while (p.running && (ticks++ < 500000)) {
			p.runOneInst();
		}
		if (p.running)
			busy = true;
		if (p.exited && p.pagemapPage != 0) {
			// XXX: obey wait options etc
			p.freeResources();
			p.closeFds();
			for (var n = 0; n < p.exitCallbacks.length; ++n)
				p.exitCallbacks[n]();
			if (i == 0) {
				console.log("done (" + p.exitCode + "), ran " + instCount + " instructions");
				printk("System halted.\n");
				if (typeof window == 'undefined')
					process.exit(p.exitCode);
				clearTimeout(myTimer);
				return;
			}
		}
		currentProcessId = 0;
	}
	// if we're using nodejs we have to keep a loop alive
	if (typeof window == 'undefined' || busy)
		wakeup();
}

var myTimer = 0;
function wakeup() {
	// TODO: use postMessage?
	clearTimeout(myTimer);
	myTimer = setTimeout(myLoop, 0);
}

function emuStart() {
	var args = ["/bin/busybox", "sh"];
	if (typeof window == 'undefined') {
		args = process.argv.slice(2);
	}

	var node = getNodeForAbsPath(args[0], false);
	if (typeof node == 'number')
		throw Error("failed to load init " + args[0]);
	var binary = node.data; // XXX: memfs only

	var p = new Process();
	processes.push(p);

	p.loadElf(binary, args, []);
	myLoop();
}

var bootTime = new Date();
var printk = function(string) {
	var str = string;
	var mytime = ("     " + ((new Date() - bootTime) / 1000).toFixed(6)).slice(-12);
	if (typeof window ==='undefined') {
		process.stdout.write("[" + mytime + "] " + str);
	} else {
		terminalObj.write("[" + mytime + "] " + str);
	}
}

if (typeof window == 'undefined') {
	// node.js
	try { process.stdin.setRawMode(true); } catch (e) { }

	// load from squashfs in local case 
	var fs = require('fs');
	var indata = fs.readFileSync('debian.squashfs');
	fsRoot = new SquashFS(indata.buffer).root;

	printk("running in node.js mode\n");
	emuStart();
} else {
	function goEmulatorGo(term) {
		terminalObj = term;

		printk("ajaxfs: retrieving filesystem\n");
		var xhr = new XMLHttpRequest();
		xhr.onload = function() {
			printk("ajaxfs: done\n");
			fsRoot.children['bin'].children['busybox'].data = xhr.response;
			emuStart();
		}
		xhr.responseType = "arraybuffer";
		xhr.open("GET", "busybox", true);
		xhr.send();
	}
}
