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
		if (p.exited && p.pagemapPage == 0)
			continue;
		currentProcessId = i;
		var ticks = 0;
		// Beware: there is a significant performance penalty for re-scheduling.
		if (p.running)
			instCount = instCount + p.runInstLoop(500000);
		if (p.running)
			busy = true;
		if (p.exited && p.pagemapPage != 0) {
			// XXX: obey wait options etc
			p.freeResources();
			p.closeFds();
			for (var n = 0; n < p.exitCallbacks.length; ++n)
				p.exitCallbacks[n]();
			p.exit_notify();
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
	mountProc();

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

	// FIXME: is this right?
	p.pinfo.leader = true;
	p.pinfo.tty = termTTY;
	termTTY.pgrp = p.pid;
	termTTY.session = p.pid;

	var env = ["TERM=xterm"];
	p.loadElf(binary, args, env);
	myLoop();
}

var bootTime = new Date();
var kernelLog = "";
var printk = function(str) {
	var mytime = ("     " + ((new Date() - bootTime) / 1000).toFixed(6)).slice(-12);
	var line = "[" + mytime + "] " + str;
	kernelLog = kernelLog + line;
	if (typeof window ==='undefined') {
		process.stdout.write(line);
	} else {
		termstream.write(null, line);
	}
}

var goEmulatorGo = null;

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
	goEmulatorGo = function(term) {
		termstream = new TerminalBackedFile(term);
		termTTY = new TTY(termstream, termstream);

		localforage.getItem('rootfs', function(err, value) {
			if (value) {
				printk("ajaxfs: found in local storage\n");
				fsRoot = new SquashFS(value).root;
				emuStart();
				return;
			}

			printk("ajaxfs: retrieving filesystem\n");
			var xhr = new XMLHttpRequest();
			xhr.onload = function() {
				printk("ajaxfs: download complete\n");
				localforage.setItem('rootfs', xhr.response);
				fsRoot = new SquashFS(xhr.response).root;
				emuStart();
			}
			xhr.responseType = "arraybuffer";
			xhr.open("GET", "debian.squashfs", true);
			xhr.send();
		});
	}
}
