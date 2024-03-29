
// Allocate 256mb RAM for now.
var memSize = (1024 * 1024 * 256)|0;
var totalPages = (memSize / 65536)|0;
var memory = new ArrayBuffer(memSize);

// We allow a maximum of 1gb of RAM to be allocated, in 64kB pages (16384 pages).
// This means that we can fit a 32-bit integer for every page, in one page.
var mem32 = new Uint32Array(memory);

// Each "thread" needs:
// * A private area for registers, local state, etc.
// Each process needs:
// * Page table: One page of indexes, one page of flags.

// Reference counters and general information for physical pages.
var pageRefCountsBuffer = new ArrayBuffer(totalPages * 4);
var pageRefCounts = new Uint32Array(pageRefCountsBuffer);
var pageInfo = new Array(totalPages);

// page 0 contains the global page flags
var globalPageFlags = new Uint32Array(memory, 16384);
pageRefCounts[0]++;
// page 1 is the zero page
pageRefCounts[1]++;
globalPageFlags[1] = PROT_READ;
// pages 2-9 are used for process state (512 bytes = 128 processes per page)
var stateEntriesInUse = new Array(128 * 8);
const firstFreePage = 10;

function allocateStateEntry() {
	for (var p = 0; p < stateEntriesInUse.length; ++p) {
		if (!stateEntriesInUse[p]) {
			stateEntriesInUse[p] = true;
			return p;
		}
	}
	throw Error("too many processes");
}

function freeStateEntry(p) {
	stateEntriesInUse[p] = false;
}

function allocatePage(flags) {
	for (var b = firstFreePage; b < totalPages; ++b) {
		if (pageRefCounts[b] == 0) {
			pageRefCounts[b]++;
			globalPageFlags[b] = flags;
			return b;
		}
	}
	throw Error("out of memory (no spare pages)");
}

function cowDupPage(pageno) {
	if (pageno == 1)
		return zeroPage();
	// FIXME: do something like VM_MAY etc rather than letting guests do as they please
	globalPageFlags[pageno] |= VM_SHARED;
	globalPageFlags[pageno] &= (~PROT_WRITE);
	pageRefCounts[pageno]++;
	return pageno;
}

function duplicatePage(oldpage) {
	if (pageRefCounts[oldpage] == 0) throw Error("trying to duplicate page with no refs");
	var newpage = allocatePage(globalPageFlags[oldpage] & (~VM_SHARED));
	// TODO: use .set()?
	var src = oldpage << 14;
	var dest = newpage << 14;
	for (var b = 0; b < 16384; ++b) {
		mem32[dest++] = mem32[src++];
	}
	return newpage;
}

function doZeroPage(pageno) {
	if (pageRefCounts[pageno] != 1) throw Error("trying to zero page with refs!=1");
	var dest = pageno << 14;
	for (var b = 0; b < 16384; ++b)
		mem32[dest++] = 0;
}

function zeroPage() {
	pageRefCounts[1]++;
	return 1;
}

function freePage(pageno) {
	if (pageRefCounts[pageno] == 0)
		throw Error("tried to free page " + pageno + " which isn't in use");
	pageRefCounts[pageno]--;
	if (pageRefCounts[pageno] == 0)
		globalPageFlags[pageno] = 0;
	if (pageRefCounts[pageno] == 0 && pageno == 1)
		throw Error("zero page ended up unreferenced?");
}

// At the time of writing, the MIPS/Linux "vdso" is just a page containing two
// trampolines (sigreturn and rt_sigreturn), not exposed to userspace. We do the
// same thing.
var vdsoPage = allocatePage(PROT_READ | PROT_EXEC);
mem32[(vdsoPage << 14) + 0] = 0x20021017; // li sigreturn
mem32[(vdsoPage << 14) + 4] = 0x0000000c; // syscall
mem32[(vdsoPage << 14) + 8] = 0x20021061; // li rt_sigreturn
mem32[(vdsoPage << 14) + 12] = 0x0000000c; // syscall

// MIPS has 32 normal and 32 fp registers.
const STATE_PC = 64;
const STATE_PENDINGBRANCH = 65;
const STATE_REG_LOW = 66;
const STATE_REG_HIGH = 67;

const STATE_COPY_COUNT = 68; // state copied in clone()

// pointers into memory
const STATE_PAGEMAP = 68;
const STATE_PAGEFLAGS = 69;

// this is ~= signal_struct
function ProcessInfo() {
	this.flags = 0;
	this.leader = false; // is *session* leader
	this.tty = null; // controlling tty
}

// ProcessInfo.flags (see sched.h)
var SIGNAL_STOP_STOPPED = 1;
var SIGNAL_STOP_CONTINUED = 2;
var SIGNAL_GROUP_EXIT = 4;
// TODO: do we care about these?
var SIGNAL_CLD_STOPPED = 0x10;
var SIGNAL_CLD_CONTINUED = 0x20;

var vdsoMappedAt = 0xe0000;

function Process() {
	// note: buffers always initialized to zero

	// We don't allow mappings at NULL, so pendingbranch zero is 'no branch'.

	// To simplify blocking system calls, we store oldpc/pendingbranch so we can revert back.
	// (The real kernel also re-executes branches; see kernel/branch.c)

	// Views into global memory.
	this.mem8 = new Uint8Array(memory);
	this.mem32 = new Uint32Array(memory);

	this.createMaps = function() {
		this.pagemap = new Uint16Array(memory, this.pagemapPage << 16, 32768);
		this.pageflags = new Uint16Array(memory, this.pageflagsPage << 16, 32768);

		this.state = new Uint32Array(memory, this.stateOffset);
		this.registers = new Uint32Array(memory, this.stateOffset);
		this.fpregs32 = new Float32Array(memory, this.stateOffset);
		this.fpregs64 = new Float64Array(memory, this.stateOffset);
	}

	this.invalidateHacks = function() {
		this.optOldPhysPage = 0xffffffff >>> 0;
		this.optOlderPhysPage = 0xffffffff >>> 0;
//		this.optOldestPhysPage = 0xffffffff >>> 0;
		this.optOldWritePhysPage = 0xffffffff >>> 0;
		this.optOldCodePhysPage = 0xffffffff >>> 0;
		this.optOlderCodePhysPage = 0xffffffff >>> 0;
//		this.optOldestCodePhysPage = 0xffffffff >>> 0;
		this.optOldAddr = 0xffffffff >>> 0;
		this.optOlderAddr = 0xffffffff >>> 0;
//		this.optOldestAddr = 0xffffffff >>> 0;
		this.optOldWriteAddr = 0xffffffff >>> 0;
		this.optOldCodeAddr = 0xffffffff >>> 0;
		this.optOlderCodeAddr = 0xffffffff >>> 0;
//		this.optOldestCodeAddr = 0xffffffff >>> 0;
	}

	this.initMemory = function() {
		this.stateEntry = allocateStateEntry();
		this.stateOffset = (2 * 0x10000 + 512 * this.stateEntry) >>> 0;

		this.pagemapPage = allocatePage(PROT_NONE);
		this.pageflagsPage = allocatePage(PROT_NONE);

		// TODO: think about this
		this.mmapHackStart = 0x2000000;

		this.invalidateHacks();

		this.brk = 0;
		this.tlsAddr = 0;

		this.createMaps();

		for (var n = 0; n < STATE_COPY_COUNT; ++n) {
			this.state[n] = 0;
		}
		this.state[STATE_PAGEMAP] = this.pagemapPage << 16;
		this.state[STATE_PAGEFLAGS] = this.pageflagsPage << 16;

		// could also just doZeroPage(); both pages..
		for (var n = 0; n < this.pagemap.length; ++n) {
			this.pagemap[n] = 0;
			this.pageflags[n] = 0;
		}

		pageRefCounts[vdsoPage]++;
		this.pagemap[vdsoMappedAt >> 16] = vdsoPage;
		this.pageflags[vdsoMappedAt >> 16] = PROT_READ | PROT_EXEC;

		for (var n = 0; n < _NSIG; ++n) {
			this.signalactions[n] = new Object();
			this.signalactions[n].sa_handler = SIG_DFL;
			this.signalactions[n].sa_flags = 0;
			this.signalactions[n].sa_mask = 0;
		}

		this.pinfo = new ProcessInfo();
	}

	this.signalactions = new Array(_NSIG);
	this.signalQueue = [];

	this.initMemory();

	this.isFatalSignal = function(signo) {
		return (!isStopSignal(signo) && !isIgnoredSignal(signo) && this.signalactions[signo-1].sa_handler == SIG_DFL);
	}

	function isIgnoredSignal(signo) {
		return (signo == SIGCONT) || (signo == SIGCHLD) || (signo == SIGWINCH) || (signo == SIGURG);
	}

	function isStopSignal(signo) {
		return (signo == SIGSTOP) || (signo == SIGTSTP) || (signo == SIGTTIN) || (signo == SIGTTOU);
	}

	// TODO: this doesn't deal with threads
	this.sendSignal = function(signo, info) {
		// prepare
		if (isStopSignal(signo)) {
			// FIXME: remove all SIGCONT
		} else if (signo == SIGCONT) {
			// FIXME: remove all stop signals, do wake up stuff
		}

		// drop duplicate non-rt signals
		if (signo < SIGRTMIN) {
			for (var n = 0; n < this.signalQueue.length; ++n) {
				if (this.signalQueue[n].si_signo == signo)
					return;
			}
		}

		// queue (if not SIGSTOP/SIGKILL)
		// FIXME: we should use the provided info?
		var siginfo = new Object();
		siginfo.si_signo = signo;
		// FIXME
		this.signalQueue.push(siginfo);

		// FIXME: signalfd_notify

		// complete
		if (this.isFatalSignal(signo)) {
			// FIXME: do a group exit with signo as exit code
			this.exitCode = signo;
			this.running = false;
			this.exited = true;
			return;
		}

		// wake up
		this.running = true;
		wakeup();
	}

	this.handleSignal = function() {
		var siginfo = this.signalQueue.shift();

		// FIXME: child stuff from get_signal?

		var action = this.signalactions[siginfo.si_signo-1];
		// FIXME: dequeue_signal stuff

		if (action.sa_handler == SIG_IGN)
			return;
		if (action.sa_handler != SIG_DFL) {
			this.setupFrameForSignal((action.sa_flags & SA_SIGINFO), siginfo);

			if (action.sa_flags & SA_ONESHOT)
				action.sa_handler = SIG_DFL;

			return;
		}

		if (isIgnoredSignal)
			return;

		// init doesn't get signals.
		if (this.pid == 1)
			return;

		if (isStopSignal(siginfo.si_signo)) {
			// FIXME

			return;
		}

		// fatal signal
		// FIXME
		//console.log("TODO: fatal signal");
	}

	this.setupFrameForSignal = function(is_rt, siginfo) {
		var action = this.signalactions[siginfo.si_signo-1];

		var sp = this.registers[29];
		sp = sp - STATE_COPY_COUNT * 4;
		for (var n = 0; n < STATE_COPY_COUNT; ++n)
			this.write32(sp + n*4, this.registers[n]);
		// FIXME: altstack
		// FIXME: save altstack
		// FIXME: sigmask
		// FIXME: anything else :)

		this.registers[4] = siginfo.si_signo;
		this.registers[29] = sp;

		// FIXME: registers[5] contains rs_info for rt
		// FIXME: registers[6] contains rs_uc (rt) or sf_sc
		if (is_rt) {
			this.registers[5] = 0; // FIXME
			// sig_return
			this.registers[31] = vdsoMappedAt + 8;
		} else {
			this.registers[5] = 0;
			// sig_return
			this.registers[31] = vdsoMappedAt + 0;
		}

		this.registers[25] = action.sa_handler;
		this.registers[STATE_PC] = action.sa_handler;
		this.registers[STATE_PENDINGBRANCH] = 0;
	}

	this.popFrameAfterSignal = function(is_rt) {
		var sp = this.registers[29];
		for (var n = 0; n < STATE_COPY_COUNT; ++n)
			this.registers[n] = this.read32(sp + n*4);

		// FIXME: other stuff
	}

	this.exit_notify = function() {
		// FIXME: forget_original_parent
		// FIXME: reparent children to init

		// FIXME: kill_orphaned_pgrp (SIGHUP/SIGCONT to pgrp)

		// FIXME: notify parent if thread group leader
		// XXX: !!!
		if (this.ppid)
			processes[this.ppid-1].sendSignal(SIGCHLD, null);
	}

	this.exitCallbacks = [];

	this.fds = [];
	// XXX: shouldn't make them here
	this.fds[0] = termTTY;
	this.fds[1] = termTTY;
	this.fds[2] = termTTY;

	this.running = true;
	this.exited = false;
	this.exitCode = 0;

	// FIXME: these shouldn't be set here
	this.pid = 1;
	this.ppid = 0;
	this.uid = 0;
	this.euid = 0;
	this.gid = 0;
	this.egid = 0;

	// FIXME: also these..
	this.pgid = 1;
	this.sid = 1;

	this.cwd = "/";

	this.cloneFrom = function(source) {
		// Caller is responsible for setting pid/ppid.

		// XXX
		this.mmapHackStart = source.mmapHackStart;

		this.createMaps();
		for (var n = 0; n < STATE_COPY_COUNT; ++n) {
			this.state[n] = source.state[n];
		}

		// FIXME: be smarter
		for (var n = 0; n < this.pagemap.length; ++n) {
			if (source.pagemap[n]) {
				this.pagemap[n] = cowDupPage(source.pagemap[n]);
				this.pageflags[n] = source.pageflags[n];
			}
		}

		// Invalidate everyone's cached page flags (we might have COWed).
		for (var p = 0; p < processes.length; ++p) {
			processes[p].invalidateHacks();
		}

		this.brk = source.brk;
		this.tlsAddr = source.tlsAddr;

		this.cwd = source.cwd;

		// FIXME: think about duplicating
		this.fds = [];
		for (var n = 0; n < source.fds.length; ++n) {
			if (source.fds[n])
				this.fds.push(source.fds[n].clone());
			else
				this.fds.push(null);
		}

		for (var n = 0; n < _NSIG; ++n) {
			this.signalactions[n].sa_handler = source.signalactions[n].sa_handler;
			this.signalactions[n].sa_flags = source.signalactions[n].sa_flags;
			this.signalactions[n].sa_mask = source.signalactions[n].sa_mask;
		}

		// FIXME: this.pinfo
		this.pinfo.tty = source.pinfo.tty;

		// TODO: ids
	}

	this.freeResources = function() {
		for (var n = 0; n < this.pagemap.length; ++n) {
			if (this.pagemap[n])
				freePage(this.pagemap[n]);
		}
		freePage(this.pagemapPage);
		freePage(this.pageflagsPage);
		this.pagemapPage = 0;
		this.pageflagsPage = 0;
		this.pagemap = null;
		this.pageflags = null;

		freeStateEntry(this.stateEntry);
		this.stateEntry = null;
		this.stateOffset = null;
		this.state = null;
		this.registers = null;
	}

	this.closeFds = function() {
		for (var n = 0; n < this.fds.length; ++n) {
			if (this.fds[n])
				this.fds[n].close();
		}
	}

	this.read32 = function(addr) {
		var mapped = this.translate(addr, PROT_READ);
		if ((addr & 0x03) == 0x0) {
			return mem32[mapped >> 2];
		}
		var v = this.mem8[mapped];
		v += this.mem8[this.translate(addr + 1, PROT_READ)] << 8;
		v += this.mem8[this.translate(addr + 2, PROT_READ)] << 16;
		v += this.mem8[this.translate(addr + 3, PROT_READ)] << 24;
		// console.log("unaligned read " + addr.toString(16) + " (" + v.toString(16) + ")");
		return v >>> 0;
	}

	this.read16 = function(addr) {
		// FIXME 
		var v = this.mem8[this.translate(addr, PROT_READ)];
		v += this.mem8[this.translate(addr + 1, PROT_READ)] << 8;
		return v >>> 0;
	}

	this.read8 = function(addr) {
		var v = this.mem8[this.translate(addr, PROT_READ)];
		return v >>> 0;
	}

	this.write8 = function(addr, value) {
		this.mem8[this.translate(addr, PROT_WRITE)] = value & 0xff;
	}

	this.write16 = function(addr, value) {
		// FIXME 
		this.mem8[this.translate(addr, PROT_WRITE)] = value & 0xff;
		this.mem8[this.translate(addr + 1, PROT_WRITE)] = (value >>> 8) & 0xff;
	}

	this.write32 = function(addr, value) {
		var mapped = this.translate(addr, PROT_WRITE);
		if ((addr & 0x03) == 0x0) {
			mem32[mapped >> 2] = value;
			return;
		}
		// console.log("unaligned write " + addr.toString(16) + " (" + value.toString(16) + ")");
		this.mem8[mapped] = value & 0xff;
		this.mem8[this.translate(addr + 1, PROT_WRITE)] = (value >>> 8) & 0xff;
		this.mem8[this.translate(addr + 2, PROT_WRITE)] = (value >>> 16) & 0xff;
		this.mem8[this.translate(addr + 3, PROT_WRITE)] = (value >>> 24) & 0xff;
	}

	this.copyToUser = function(addr, data, isString) {
		for (var n = 0; n < data.length; ++n)
			this.mem8[this.translate(addr++, PROT_WRITE)] = data[n].charCodeAt(0);
		if (isString)
			this.mem8[this.translate(addr++, PROT_WRITE)] = 0;
	}

	this.stringFromUser = function(addr) {
		// FIXME
		var str = "";
		while (true) {
			var v = this.mem8[this.translate(addr++, PROT_READ)];
			if (v == 0) break;
			str += String.fromCharCode(v);
		}
		return str;
	}

	this.loadElf = function(buffer, argv, envp) {
		function makeProtFlags(pFlags) {
			var r = 0;
			if (pFlags & 0x1) r |= PROT_EXEC;
			if (pFlags & 0x2) r |= PROT_WRITE;
			if (pFlags & 0x4) r |= PROT_READ;
			return r;
		}

		// XXX: sigh
		if (typeof buffer == 'string') {
			var tmpbuf = new ArrayBuffer(buffer.length);
			var tmpview = new Uint8Array(tmpbuf);
			for (var n = 0; n < buffer.length; ++n)
				tmpview[n] = buffer.charCodeAt(n);
			buffer = tmpbuf;
		}

		var elf = new ELFFile(buffer);
		var u8a = new Uint8Array(buffer);
		var u32a = new Uint32Array(buffer);

		var baseaddr = undefined;

		var load_bias = 0x2000000;

		// TODO: We just quietly assume headers/sections are aligned.
		for (var p = 0; p < elf.headers.length; ++p) {
			var header = elf.headers[p];

			// TODO: think about this
			// We move dynamic programs by a fixed offset to get them out of the way.
			if (elf.objType == ET_DYN)
				header.pVAddr += load_bias;

			switch (header.pType) {
			case 1: // PT_LOAD
				//console.log("mapping section at 0x" + header.pVAddr.toString(16));
				if (baseaddr == undefined)
					baseaddr = header.pVAddr - header.pOffset;
				for (var b = 0; b < header.pFileSz; ++b) {
					// FIXME: allocate memory :)
					var pageId = this.pagemap[(header.pVAddr + b) >>> 16];
					if (pageId == 1) throw Error("elf loader overlap bug");
					if (pageId == 0) {
						this.pagemap[(header.pVAddr + b) >>> 16] = allocatePage(makeProtFlags(header.pFlags));
						doZeroPage(this.pagemap[(header.pVAddr + b) >>> 16]); // TODO: only if needed
						this.pageflags[(header.pVAddr + b) >>> 16] = makeProtFlags(header.pFlags);
					}
					this.mem8[this.translate(header.pVAddr + b, PROT_NONE)] = u8a[header.pOffset + b];
				}
				for (var b = header.pFileSz; b < header.pMemSz; ++b) {
					var pageId = this.pagemap[(header.pVAddr + b) >>> 16];
					if (pageId == 0) {
						this.pagemap[(header.pVAddr + b) >>> 16] = zeroPage();
						this.pageflags[(header.pVAddr + b) >>> 16] = makeProtFlags(header.pFlags);
					}
				}
				break;
//			case 0x70000000: // PT_MIPS_REGINFO
				// The 6th value is the initial value of the gp register.
				// (This seems to be handled by libc.)
//				this.registers[28] = u32a[(header.pOffset >>> 2) + 5];
//				break;
			}
		}

		var interp_baseaddr = baseaddr;

		// XXX: see above
		if (elf.objType == ET_DYN)
			elf.entryPoint += load_bias;

		this.registers[STATE_PC] = elf.entryPoint;
		this.registers[STATE_PENDINGBRANCH] = 0;

		// FIXME: handle elf intepreter case
		if (elf.elf_interpreter.length) {
			var node = getNodeForAbsPath(elf.elf_interpreter, false);
			// TODO: manpage says errors are a bit different
			if (typeof node == 'number')
				throw Error("failed to load ELF interpreter " + elf.elf_interpreter);

			// XXX: direct .data access
			var elf_interp = new ELFFile(node.data);
			var iu8a = new Uint8Array(node.data);

			// FIXME: many things, also we should load at an offset
			for (var p = 0; p < elf_interp.headers.length; ++p) {
				var header = elf_interp.headers[p];

				// TODO: this is an ugly hack
				header.pVAddr += 0x10000;
				//console.log("mapping interp section at 0x" + header.pVAddr.toString(16));

				if (interp_baseaddr == baseaddr)
					interp_baseaddr = header.pVAddr - header.pOffset;

				switch (header.pType) {
				case 1: // PT_LOAD
					for (var b = 0; b < header.pFileSz; ++b) {
						// FIXME: allocate memory :)
						var pageId = this.pagemap[(header.pVAddr + b) >>> 16];
						if (pageId == 1) throw Error("elf loader overlap bug");
						if (pageId == 0) {
							this.pagemap[(header.pVAddr + b) >>> 16] = allocatePage(makeProtFlags(header.pFlags));
							doZeroPage(this.pagemap[(header.pVAddr + b) >>> 16]); // TODO: only if needed
							this.pageflags[(header.pVAddr + b) >>> 16] = makeProtFlags(header.pFlags);
						}
						this.mem8[this.translate(header.pVAddr + b, PROT_NONE)] = iu8a[header.pOffset + b];
					}
					for (var b = header.pFileSz; b < header.pMemSz; ++b) {
						var pageId = this.pagemap[(header.pVAddr + b) >>> 16];
						if (pageId == 0) {
							this.pagemap[(header.pVAddr + b) >>> 16] = zeroPage();
							this.pageflags[(header.pVAddr + b) >>> 16] = makeProtFlags(header.pFlags);
						}
					}
				break;
				}
			}

			// XXX: ugly hack again (see above)
			this.registers[STATE_PC] = elf_interp.entryPoint + 0x10000;
		}

		// FIXME: allocate heap, stack
		this.brk = 0x8000000;
		for (var p = 0; p < 100; ++p) {
			this.pagemap[0x800 + p] = zeroPage();
			this.pageflags[0x800 + p] = PROT_READ | PROT_WRITE;
		}

		// In practice, not even a single page of the stack seems to generally be used.
		// FIXME: stack flags?
		var sp = 0xc000ff0;
		for (var p = 0; p < 10; ++p) {
			this.pagemap[0xc00 - p] = zeroPage();
			this.pageflags[0xc00 - p] = PROT_READ | PROT_WRITE;
		}

		// XXX hack for args
		var dummy = 0xb000000;
		this.pagemap[0xb00] = zeroPage();
		this.pageflags[0xb00] = PROT_READ | PROT_WRITE; // XXX?
		var argp = new Array();
		var envpp = new Array();

		for (var a = 0; a < argv.length; ++a) {
			argp.push(dummy);
			var tmp = argv[a];
			for (var n = 0; n < tmp.length; ++n)
				this.mem8[this.translate(dummy++, PROT_WRITE)] = tmp[n].charCodeAt(0);
			this.mem8[this.translate(dummy++, PROT_WRITE)] = 0;
		}
		for (var a = 0; a < envp.length; ++a) {
			envpp.push(dummy);
			var tmp = envp[a];
			for (var n = 0; n < tmp.length; ++n)
				this.mem8[this.translate(dummy++, PROT_WRITE)] = tmp[n].charCodeAt(0);
			this.mem8[this.translate(dummy++, PROT_WRITE)] = 0;
		}

		sp = sp - (19 + argp.length + envpp.length)*4; // FIXME: de-hardcode
		this.registers[29] = sp;

		// Write arguments/environment.
		this.write32(sp, argp.length); // argc
		sp += 4;
		for (var n = 0; n < argp.length; ++n) {
			this.write32(sp, argp[n]); // argv
			sp += 4;
		}
		this.write32(sp, 0); // argv end
		sp += 4;
		for (var n = 0; n < envpp.length; ++n) {
			this.write32(sp, envpp[n]); // envp
			sp += 4;
		}
		this.write32(sp, 0); // envv
		sp += 4;

		// Write the ELF aux info into the stack.
		this.write32(sp, 3); // AT_PHDR
		sp += 4;
		this.write32(sp, baseaddr + elf.phOffset);
		sp += 4;
		this.write32(sp, 4); // AT_PHENT
		sp += 4;
		this.write32(sp, elf.phEntSize);
		sp += 4;
		this.write32(sp, 5); // AT_PHNUM
		sp += 4;
		this.write32(sp, elf.phNum);
		sp += 4;
		this.write32(sp, 7); // AT_BASE
		sp += 4;
		this.write32(sp, interp_baseaddr);
		sp += 4;
		this.write32(sp, 25); // AT_RANDOM (glibc assumes this exists)
		sp += 4;
		this.write32(sp, sp); // FIXME :)
		sp += 4;
		this.write32(sp, 9); // AT_ENTRY
		sp += 4;
		this.write32(sp, elf.entryPoint);
		sp += 4;
		//this.write32(sp, 31); // AT_EXECFN
		//sp += 4;
		//this.write32(sp, 0x100); // XXX: hack
		//sp += 4;
		this.write32(sp, 6); // AT_PAGESZ (musl assumes this exists)
		sp += 4;
		this.write32(sp, 65536);
		sp += 4;
		this.write32(sp, 0); // AT_NULL
		sp += 4;
		this.write32(sp, 0);
		sp += 4;
	}

	this.syscall = function() {
		var ret = 0;

		var syscallnr = this.registers[2];

		if (!syscalls[syscallnr]) {
			console.log("syscall " + syscallnr + " not implemented");
			return -ENOSYS;
		}
		if (showSystemCalls)
			console.log("pid " + this.pid + ": syscall " + syscallnr + " (" + syscalls[syscallnr].name + ")");

		var ret = syscalls[syscallnr](this);
		if (showSystemCalls)
			console.log("returned " + ret);

		if (this.running) {
			// return value in v0, error flag in a3 (see kernel/scall32-o32.S)
			if ((ret >> 0) < 0) {
				this.registers[2] = -ret;
				this.registers[7] = 1;
			} else {
				this.registers[2] = ret;
				this.registers[7] = 0;
			}
		}

		// TODO: We don't do this here if we're not running
		// because we want to preserve oldpc for the system
		// call restart. We should redesign this a bit.
		if (this.signalQueue.length && this.running)
			this.handleSignal();
	};

	this.translate = function(addr, prot) {
		// If this.optOldAddr contains the higher bits of addr, we're still using the same page.
		// In this case, we can use a heap address directly and avoid translation.
		// (This is rather ad-hoc but makes a huge difference in performance.)
		var shiftAddr = (addr >>> 16);
		var addrLow = (addr & 0xffff);
		if (prot == PROT_EXEC) {
			// First case is handled directly in exec loop now.
			/*if (shiftAddr == this.optOldCodeAddr)
				return this.optOldCodePhysPage + addrLow;
			else*/ if (shiftAddr == this.optOlderCodeAddr)
				return this.optOlderCodePhysPage + addrLow;
//			else if (shiftAddr == this.optOldestCodeAddr)
//				return this.optOldestCodePhysPage + addrLow;
		} else if (prot == PROT_WRITE) {
			if (shiftAddr == this.optOldWriteAddr)
				return this.optOldWritePhysPage + addrLow;
		} else {
			if (shiftAddr == this.optOldAddr)
				return this.optOldPhysPage + addrLow;
			else if (shiftAddr == this.optOlderAddr)
				return this.optOlderPhysPage + addrLow;
//			else if (shiftAddr == this.optOldestAddr)
//				return this.optOldestPhysPage + addrLow;
		}

		return this.translateMiss(addr, prot);
	}

	this.translateMiss = function(addr, prot) {
		//console.log(this.pid + " miss: " + addr.toString(16) + " (prot " + prot + ")");

		// FIXME: make sure this can't happen
		if (addr < 0)
			throw Error("you broke it address " + addr.toString(16));
		if (addr >= 0x80000000)
			throw Error("bad address " + addr.toString(16) /*+ " at pc " + this.registers[STATE_OLDPC].toString(16)*/);
		var localPageId = addr >>> 16;

		if ((this.pageflags[localPageId] & prot) != prot) {
			// "real" fault
			throw Error("fault at " + addr.toString(16) /*+ " at pc " + this.registers[STATE_OLDPC].toString(16)*/ + " (tried " + prot.toString(16) + ", local flags " + this.pageflags[localPageId].toString(16) + ")");
		}

		var pageId = this.pagemap[localPageId];
		if (pageId == 0)
			throw Error("unmapped address " + addr.toString(16) /*+ " at pc " + this.registers[STATE_OLDPC].toString(16) */);

		var pageFlags = globalPageFlags[pageId];
		if ((pageFlags & prot) != prot) {
			var oldPageId = pageId;

			// Fault, but our local flags say this is okay.
			if ((prot == PROT_WRITE) && (pageFlags & VM_SHARED)) {
				//console.log(this.pid + " hit vm_shared page@" + addr.toString(16) + ", refcount " + pageRefCounts[pageId]);
				// We can fix this by doing COW.
				if (pageRefCounts[pageId] != 1) {
					// We only need to actually do the copy if there are other users.
					pageId = duplicatePage(pageId);
					freePage(oldPageId);
					this.pagemap[localPageId] = pageId;
				}
				globalPageFlags[pageId] = this.pageflags[localPageId];
			} else if ((prot == PROT_WRITE) && (pageId == 1)) {
				// Zero page. Duplicate it.
				pageId = allocatePage(this.pageflags[localPageId]);
				//console.log("dup zero page at " + addr.toString(16) + " --> " + pageId);
				freePage(oldPageId);
				doZeroPage(pageId);
				this.pagemap[localPageId] = pageId;
			} else {
				// We don't know how to deal with this.
				throw Error("unhandled fault at " + addr.toString(16) /*+ " at pc " + this.registers[STATE_OLDPC].toString(16)*/);
			}

			this.invalidateHacks();
		}

		var pageAddr = pageId << 16;
		if (prot == PROT_EXEC) {
//			this.optOldestCodePhysPage = this.optOlderCodePhysPage;
//			this.optOldestCodeAddr = this.optOlderCodeAddr;
			this.optOlderCodePhysPage = this.optOldCodePhysPage;
			this.optOlderCodeAddr = this.optOldCodeAddr;
			this.optOldCodePhysPage = pageAddr >>> 0;
			this.optOldCodeAddr = addr >>> 16;
		} else if (prot == PROT_WRITE) {
			this.optOldWritePhysPage = pageAddr >>> 0;
			this.optOldWriteAddr = addr >>> 16;
		} else {
//			this.optOldestPhysPage = this.optOlderPhysPage;
//			this.optOldestAddr = this.optOlderAddr;
			this.optOlderPhysPage = this.optOldPhysPage;
			this.optOlderAddr = this.optOldAddr;
			this.optOldPhysPage = pageAddr >>> 0;
			this.optOldAddr = addr >>> 16;
		}
		return pageAddr + (addr & 0xffff);
	}

	this.runFpuInst = function(subOpcodeS, fmt, ft, fs, fd, simm) {
		// Unfortunately, even gcc startup needs floating-point support.
		// This is a pretty minimal (and possibly broken) implementation.
		// fmt 16 (fmt3 0) = float
		// fmt 17 (fmt3 1) = double
		// fmt 20 (fmt3 4) = 32-bit signed integer
		// fmt 21 (fmt3 5) = 64-bit signed integer, MIPS III
		//console.log(myInst.toString(16));
		// TODO: check for $fp0
		if (fmt == 0) {
			// mfc1
			if (ft == 0) return;
			this.registers[ft] = this.registers[32 + fs];
			return;
		}
		if (fmt == 8) {
			// bc
			var cc = ft >>> 2;
			if (cc != 0) throw Error("fpu: non-zero cc bit " + cc); // we're not MIPS IV
			var ifTrue = ft & 0x1;
			var likely = ft & 0x2;
			var bit = (this.registers[63] >> 23) & 0x1;
			if (ifTrue == bit) {
				this.registers[STATE_PENDINGBRANCH] = this.registers[STATE_PC] + (simm << 2);
			} else if (likely) {
				this.registers[STATE_PC] = this.registers[STATE_PC] + 4;
			}
			return;
		}
		switch (subOpcodeS) {
		case 0: // add
			if (fmt == 4) {
				// mtc1
				this.registers[32 + ft] = this.registers[fs];
				break;
			}
			if (fmt != 16 && fmt != 17) throw Error("unknown fp fmt " + fmt);
			if (fmt == 16)
				this.fpregs32[32 + fd] = this.fpregs32[32 + fs] + this.fpregs32[32 + ft];
			else
				this.fpregs64[(32 + fd) << 1] = this.fpregs64[(32 + fs) << 1] + this.fpregs64[(32 + ft) << 1];
			break;
		case 1: // sub
			if (fmt != 16 && fmt != 17) throw Error("unknown fp fmt " + fmt);
			if (fmt == 16)
				this.fpregs32[32 + fd] = this.fpregs32[32 + fs] - this.fpregs32[32 + ft];
			else
				this.fpregs64[(32 + fd) << 1] = this.fpregs64[(32 + fs) << 1] - this.fpregs64[(32 + ft) << 1];
			break;
		case 2: // mul
			if (fmt != 16 && fmt != 17) throw Error("unknown fp fmt " + fmt);
			if (fmt == 16)
				this.fpregs32[32 + fd] = this.fpregs32[32 + fs] * this.fpregs32[32 + ft];
			else
				this.fpregs64[(32 + fd) << 1] = this.fpregs64[(32 + fs) << 1] * this.fpregs64[(32 + ft) << 1];
			break;
		case 3: // div
			if (fmt != 16 && fmt != 17) throw Error("unknown fp fmt " + fmt);
			if (fmt == 16)
				this.fpregs32[32 + fd] = this.fpregs32[32 + fs] / this.fpregs32[32 + ft];
			else
				this.fpregs64[(32 + fd) << 1] = this.fpregs64[(32 + fs) << 1] / this.fpregs64[(32 + ft) << 1];
			break;
		case 6: // mov
			if (fmt != 16 && fmt != 17) throw Error("unknown fp fmt " + fmt);
			if (fmt == 16)
				this.fpregs32[32 + fd] = this.fpregs32[32 + fs];
			else
				this.fpregs64[(32 + fd) << 1] = this.fpregs64[(32 + fs) << 1];
			break;
		case 13: // trunc.w
			// FIXME: is this ok for out-of-bounds cases?
			if (fmt != 16 && fmt != 17) throw Error("unknown fp fmt " + fmt);
			if (fmt == 16)
				this.registers[32 + fd] = this.fpregs32[32 + fs] >> 0;
			else
				this.registers[32 + fd] = this.fpregs64[(32 + fs) << 1] >> 0;
			break;
		case 17: // movc
			throw Error(); // FIXME: not implemented
			var tf = ft & 0x1; // if 1, condition should be true
			var cc = ft >>> 2;
			if (cc != 0) throw Error("fpu: non-zero cc bit " + cc); // we're not MIPS IV
			var bit = (this.registers[63] >> 23) & 0x1;
			break;
		case 33: // cvt.d
			if (fmt != 16 && fmt != 20) throw Error("cvt.d: unknown fp fmt " + fmt);
			if (fmt == 16)
				this.fpregs64[(32 + fd) << 1] = this.fpregs32[32 + fs];
			else
				this.fpregs64[(32 + fd) << 1] = (this.registers[32 + fs] >> 0);
			break;
		default:
			if (subOpcodeS & 0x30) {
				// c.cond
				if (fmt != 16 && fmt != 17 && fmt != 20) throw Error("unknown fp fmt " + fmt);
				var hasExceptions = subOpcodeS & 0x8; // TODO: do we care?
				var result = false;
				switch (subOpcodeS & 0x7) {
				case 0: // false
					result = false;
					break;
				case 4: // lt
					if (fmt == 16)
						result = this.fpregs32[32 + fs] < this.fpregs32[32 + ft];
					else if (fmt == 17)
						result = this.fpregs64[(32 + fs) << 1] < this.fpregs64[(32 + ft) << 1];
					else
						result = (this.registers[32 + fs] >> 0) < (this.registers[32 + ft] >> 0);
					break;
				case 6: // le
					if (fmt == 16)
						result = this.fpregs32[32 + fs] <= this.fpregs32[32 + ft];
					else if (fmt == 17)
						result = this.fpregs64[(32 + fs) << 1] <= this.fpregs64[(32 + ft) << 1];
					else
						result = (this.registers[32 + fs] >> 0) <= (this.registers[32 + ft] >> 0);
					break;
				default:
					throw Error("unimplemented condition " + (subOpcodeS & 0x7));
				}
				if (result)
					this.registers[63] = this.registers[63] | 0x800000;
				else
					this.registers[63] = this.registers[63] & ~(0x800000);
				break;
			}

			throw new Error("bad fpu instruction " + subOpcodeS);
		}
		return;
	}

	this.signedMult = function(a, b) {
		// From Hacker's Delight, in an attempt to make this work.
		// (This seems correct now.)
		var u1 = (a & 0xffff) >>> 0;
		var v1 = (b & 0xffff) >>> 0;
		var u0 = (a >> 16);
		var v0 = (b >> 16);
		var t = (((u1 * v1) >>> 0) & 0xffffffff) >>> 0;
		var w3 = (t & 0xffff) >>> 0;
		var k = t >>> 16;
		t = (((u0*v1 + k) >>> 0) & 0xffffffff) >>> 0;
		var w2 = (t & 0xffff) >>> 0;
		var w1 = (t >> 16) >>> 0;
		var t = (((u1*v0 + w2) >>> 0) & 0xffffffff) >>> 0;
		k = (t >> 16) >>> 0;
		this.registers[STATE_REG_LOW] = ((((t << 16) + w3) >>> 0) & 0xffffffff) >>> 0;
		// line below is wrong :/
		//this.resultLow = (((this.registers[rt] >> 0) * (this.registers[rs] >> 0)) & 0xffffffff) >>> 0;
		this.registers[STATE_REG_HIGH] = (((u0*v0 + w1 + k) >>> 0) & 0xffffffff) >>> 0;
		//console.log("assert " + (this.registers[rs] >> 0) + " * " + (this.registers[rt] >> 0) + ' == 0x' + ("00000000"+ this.resultHigh.toString(16)).slice(-8) + ("00000000"+this.resultLow.toString(16)).slice(-8)); // note you have to postprocess this for negative numbers :p
	}

	this.unsignedMult = function(a, b) {
		var tl = a & 0xffff;
		var sl = b & 0xffff;
		var th = (a >>> 16) & 0xffff;
		var sh = (b >>> 16) & 0xffff;
		var low = tl * sl;
		var mid = (th * sl) + (sh * tl);
		var tmp = mid + (low >>> 16);
		this.registers[STATE_REG_LOW] = ((((mid << 16) + low) >>> 0) & 0xffffffff) >>> 0;
		this.registers[STATE_REG_HIGH] = (th * sh) + (tmp >>> 16);
		if (tmp > 0xffffffff) this.registers[STATE_REG_HIGH] += 0x10000;
		this.registers[STATE_REG_HIGH] = this.registers[STATE_REG_HIGH] >>> 0;
		//console.log("assert 0x" + this.registers[rt].toString(16) + " * 0x" + this.registers[rs].toString(16) + ' == 0x' + ("00000000"+ this.resultHigh.toString(16)).slice(-8) + ("00000000"+this.resultLow.toString(16)).slice(-8));
	}

	this.doRegImmInst = function(rt, rs, simm) {
		var registers = this.registers;
		switch (rt) {
		case 0: // bltz
			if ((registers[rs] >> 0) < 0)
				registers[STATE_PENDINGBRANCH] = registers[STATE_PC] + (simm << 2);
			break;
		case 1: // bgez
			if ((registers[rs] >> 0) >= 0)
				registers[STATE_PENDINGBRANCH] = registers[STATE_PC] + (simm << 2);
			break;
		case 2: // bltzl
			if ((registers[rs] >> 0) < 0)
				registers[STATE_PENDINGBRANCH] = registers[STATE_PC] + (simm << 2);
			else
				registers[STATE_PC] += 4;
			break;
		case 3: // bgezl
			if ((registers[rs] >> 0) >= 0)
				registers[STATE_PENDINGBRANCH] = registers[STATE_PC] + (simm << 2);
			else
				registers[STATE_PC] += 4;
			break;
		case 16: // bltzal
			registers[31] = registers[STATE_PC] + 4;
			if ((registers[rs] >> 0) < 0) {
				registers[STATE_PENDINGBRANCH] = registers[STATE_PC] + (simm << 2);
				if (showCalls) console.log(registers[STATE_PC].toString(16) + " --> call " + registers[STATE_PENDINGBRANCH].toString(16));
			}
		case 17: // bgezal
			registers[31] = registers[STATE_PC] + 4;
			if ((registers[rs] >> 0) >= 0) {
				registers[STATE_PENDINGBRANCH] = registers[STATE_PC] + (simm << 2);
				if (showCalls) console.log(registers[STATE_PC].toString(16) + " --> call " + registers[STATE_PENDINGBRANCH].toString(16));
			}
			break;
		case 18: // bltzall
			throw Error(); // FIXME
			break;
		case 19: // bgezall
			throw Error(); // FIXME
			break;
		default:
			throw new Error("bad regimm instruction " + regimm);
		}
	}

	this.runInstLoop = function(maxInsts) {
		// FIXME: think about this
		while (this.signalQueue.length)
			this.handleSignal();

		var registers = this.registers;

		var oldpc = 0;
		var oldpending = 0;
		var pc = registers[STATE_PC];
		var pending = registers[STATE_PENDINGBRANCH];

		// This function is too huge to get inlined, so we fold the loop in here...
		// ... but I don't want to indent the whole thing, so I don't.
		for (var insts = 0; insts < maxInsts; ++insts) {

		var pcaddr = 0;
		if ((pc >>> 16) != this.optOldCodeAddr)
			pcaddr = this.translate(pc, PROT_EXEC);
		else
			pcaddr = this.optOldCodePhysPage + (pc & 0xffff);
		var myInst = mem32[pcaddr >>> 2];

		var opcode = myInst >>> 26;
		var rs = (myInst >>> 21) & 0x1f;
		var rt = (myInst >>> 16) & 0x1f;
		var imm = myInst & 0xffff;
		var simm = imm >> 0;
		if (imm & 0x8000)
			simm = -(0x10000 - imm);

		/*if (debug) {
			var subOpcodeS = myInst & 0x3f; // special
			console.log("@" + pc.toString(16) + ": inst " + opcode + " (" + myInst.toString(16) + ")" + ", " + subOpcodeS);
			var debugInfo = "";
			for (var n = 0; n < 32; ++n)
				debugInfo = debugInfo + registers[n].toString(16) + " ";
			console.log(debugInfo);
		}*/

		oldpc = pc;
		pc += 4;

		// delayed branching
		if (pending) {
			pc = pending >>> 0;
			oldpending = pending;
			pending = 0;
		} else
			oldpending = 0;

		switch (opcode) {
		case 0: // special
			var subOpcodeS = myInst & 0x3f; // special
			var rd = (myInst >>> 11) & 0x1f;
			var sa = (myInst >>> 6) & 0x1f;
			switch (subOpcodeS) {
			case 0: // sll
				if (rd == 0) break;
				registers[rd] = (registers[rt] << sa) >>> 0;
				break;
			case 2: // srl
				if (rd == 0) break;
				registers[rd] = registers[rt] >>> sa;
				break;
			case 3: // sra
				if (rd == 0) break;
				registers[rd] = (registers[rt] >> sa) >>> 0;
				break;
			case 4: // sllv
				if (rd == 0) break;
				registers[rd] = (registers[rt] << (registers[rs] & 0x1f)) >>> 0;
				break;
			case 6: // srlv
				if (rd == 0) break;
				registers[rd] = (registers[rt] >>> (registers[rs] & 0x1f)) >>> 0;
				break;
			case 7: // srav
				if (rd == 0) break;
				registers[rd] = (registers[rt] >> (registers[rs] & 0x1f)) >>> 0;
				break;
			case 8: // jr
				pending = registers[rs];
				//if (debug) console.log("--- jmp " + pending.toString(16));
				break;
			case 9: // jalr
				pending = registers[rs];
				//if (showCalls) console.log(pc.toString(16) + " --> call " + pending.toString(16));
				if (rd == 0) break;
				registers[rd] = pc + 4;
				break;
			case 12: // syscall
				registers[STATE_PC] = pc;
				registers[STATE_PENDINGBRANCH] = pending;
				this.syscall();
				pc = registers[STATE_PC];
				pending = registers[STATE_PENDINGBRANCH];
				break;
			case 13: // break
				throw Error("breakpoint"); // FIXME
				break;
			case 15: // sync
				// There is no shared memory in our world.
				break;
			case 16: // mfhi
				if (rd == 0) break;
				registers[rd] = registers[STATE_REG_HIGH];
				break;
			case 17: // mthi
				registers[STATE_REG_HIGH] = registers[rs];
				break;
			case 18: // mflo
				if (rd == 0) break;
				registers[rd] = registers[STATE_REG_LOW];
				break;
			case 19: // mtlo
				registers[STATE_REG_LOW] = registers[rs];
				break;
			case 24: // mult
				this.signedMult(registers[rt], registers[rs]);
				break;
			case 25: // multu
				this.unsignedMult(registers[rt], registers[rs]);
				break;
			case 26: // div
				if (registers[rt] == 0)
					break; // undefined
				registers[STATE_REG_LOW] = ((registers[rs] >> 0) / (registers[rt] >> 0)) >>> 0;
				registers[STATE_REG_HIGH] = ((((registers[rs] >> 0) % (registers[rt] >> 0)) + (registers[rt] >> 0)) % (registers[rt] >> 0)) >>> 0;
				break;
			case 27: // divu
				if (registers[rt] == 0)
					break; // undefined
				registers[STATE_REG_LOW] = (registers[rs] / registers[rt]) >>> 0;
				registers[STATE_REG_HIGH] = (registers[rs] % registers[rt]) >>> 0;
				break;
			case 32: // add
				// We don't trap.
				if (rd == 0) break;
				registers[rd] = (registers[rt] + registers[rs]) >>> 0;
				break;
			case 33: // addu
				if (rd == 0) break;
				registers[rd] = (registers[rt] + registers[rs]) >>> 0;
				break;
			case 34: // sub
				// We don't trap.
				if (rd == 0) break;
				registers[rd] = (registers[rs] - registers[rt]) >>> 0;
				break;
			case 35: // subu
				if (rd == 0) break;
				registers[rd] = (registers[rs] - registers[rt]) >>> 0;
				break;
			case 36: // and
				if (rd == 0) break;
				registers[rd] = registers[rt] & registers[rs];
				break;
			case 37: // or
				if (rd == 0) break;
				registers[rd] = registers[rt] | registers[rs];
				break;
			case 38: // xor
				if (rd == 0) break;
				registers[rd] = registers[rt] ^ registers[rs];
				break;
			case 39: // nor
				if (rd == 0) break;
				registers[rd] = ~(registers[rt] | registers[rs]);
				break;
			case 42: // slt
				if (rd == 0) break;
				if ((registers[rs] >> 0) < (registers[rt] >> 0))
					registers[rd] = 1;
				else
					registers[rd] = 0;
				break;
			case 43: // sltu
				if (rd == 0) break;
				if (registers[rs] < registers[rt])
					registers[rd] = 1;
				else
					registers[rd] = 0;
				break;
			case 48: // tge
				throw Error(); // FIXME
				break;
			case 49: // tgeu
				throw Error(); // FIXME
				break;
			case 50: // tlt
				throw Error(); // FIXME
				break;
			case 51: // tltu
				throw Error(); // FIXME
				break;
			case 52: // teq
				if (registers[rs] == registers[rt])
					throw Error("teq");
				break;
			case 53: // tne
				if (registers[rs] != registers[rt])
					throw Error("tne");
				break;
			default:
				throw new Error("bad special instruction " + subOpcodeS);
			}
			break;
		case 31: // more special
			var subOpcodeS = myInst & 0x3f; // special
			var rd = (myInst >>> 11) & 0x1f;
			switch (subOpcodeS) {
			case 59: // rdhwr
				// This is emulated by the kernel.
				switch (rd) {
				case 29:
					// TLS pointer.
					if (rt == 0) break;
					registers[rt] = this.tlsAddr;
					break;
				default:
					throw new Error("unhandled rdhwr value " + rd);
				}
				break;
			default:
				throw new Error("bad extra special instruction " + subOpcodeS);
			}
			break;
		case 1: // regimm
			registers[STATE_PC] = pc;
			registers[STATE_PENDINGBRANCH] = pending;
			this.doRegImmInst(rt, rs, simm);
			pc = registers[STATE_PC];
			pending = registers[STATE_PENDINGBRANCH];
			break;
		case 2: // j
			var target = myInst & 0x3ffffff;
			pending = (pc & 0xf0000000) | (target << 2);
			break;
		case 3: // jal
			var target = myInst & 0x3ffffff;
			pending = (pc & 0xf0000000) | (target << 2);
			registers[31] = pc + 4;
			//if (debug) console.log("--> call " + pending.toString(16));
			break;
		case 4: // beq
			if (registers[rs] == registers[rt])
				pending = pc + (simm << 2);
			break;
		case 20: // beql
			if (registers[rs] == registers[rt])
				pending = pc + (simm << 2);
			else
				pc += 4;
			break;
		case 5: // bne
			if (registers[rs] != registers[rt])
				pending = pc + (simm << 2);
			break;
		case 21: // bnel
			if (registers[rs] != registers[rt])
				pending = pc + (simm << 2);
			else
				pc += 4;
			break;
		case 6: // blez
			if ((registers[rs] >> 0) <= 0)
				pending = pc + (simm << 2);
			break;
		case 22: // blezl
			if ((registers[rs] >> 0) <= 0)
				pending = pc + (simm << 2);
			else
				pc += 4;
			break;
		case 7: // bgtz
			if ((registers[rs] >> 0) > 0)
				pending = pc + (simm << 2);
			break;
		case 23: // bgtzl
			if ((registers[rs] >> 0) > 0)
				pending = pc + (simm << 2);
			else
				pc += 4;
			break;
		case 8: // addi
			// We don't trap.
			if (rt == 0) break;
			registers[rt] = (registers[rs] + simm) >>> 0;
			break;
		case 9: // addiu
			if (rt == 0) break;
			registers[rt] = (registers[rs] + simm) >>> 0;
			break;
		case 10: // slti
			if (rt == 0) break;
			if ((registers[rs] >> 0) < simm)
				registers[rt] = 1;
			else
				registers[rt] = 0;
			break;
		case 11: // sltiu
			if (rt == 0) break;
			if (registers[rs] < (simm >>> 0))
				registers[rt] = 1;
			else
				registers[rt] = 0;
			break;
		case 12: // andi
			if (rt == 0) break;
			registers[rt] = registers[rs] & imm;
			break;
		case 13: // ori
			if (rt == 0) break;
			registers[rt] = registers[rs] | imm;
			break;
		case 14: // xori
			if (rt == 0) break;
			registers[rt] = registers[rs] ^ imm;
			break;
		case 15: // lui
			// assert(rs == 0);
			if (rt == 0) break;
			registers[rt] = imm << 16;
			break;
		case 32: // lb
			if (rt == 0) break;
			var addr = registers[rs] + simm;
			var v = this.read8(addr);
			if (v & 0x80) v |= 0xffffff00;
			registers[rt] = v;
			break;
		case 33: // lh
			if (rt == 0) break;
			var addr = registers[rs] + simm;
			var v = this.read16(addr >>> 0);
			if (v & 0x8000) v |= 0xffff0000;
			registers[rt] = v;
			break;
		case 37: // lhu
			if (rt == 0) break;
			var addr = registers[rs] + simm;
			var v = this.read16(addr >>> 0);
			registers[rt] = v;
			break;
		case 34: // lwl
			if (rt == 0) break;
			var addr = (registers[rs] + simm) >>> 0;
			var mask = addr & 0x3;
			addr = addr & 0xfffffffc;
			var value = this.read32(addr);

			// lwl is usually called with address+3, so we want to take the data with
			// higher addresses (on little-endian: the least-significant bits)

			// Take the aligned bytes starting here (mask 0 = 1, mask 3 = all of them).
			if (mask == 3) {
				registers[rt] = value;
				break;
			}

			// Take the least-significant bits, which become the most-significant ones.
			value = value << ((3 - mask) * 8);

			// Use only the least-significant bits in the register.
			mask = (0xffffffff >>> ((1 + mask) * 8)) >>> 0;
			registers[rt] = (registers[rt] & mask) | value;
			break;
		case 38: // lwr
			if (rt == 0) break;
			var addr = (registers[rs] + simm) >>> 0;
			var mask = addr & 0x3;
			addr = addr & 0xfffffffc;
			var value = this.read32(addr);

			// Take the aligned bytes ending here (mask 0 = all, 1 = 3 of them, ...).
			if (mask == 0) {
				registers[rt] = value;
				break;
			}

			// Take the most-significant bits, which become the least-significant ones.
			value = value >>> (mask * 8);

			// Use only the most-significant bits in the register.
			mask = (0xffffffff << ((4 - mask) * 8)) >>> 0;
			registers[rt] = (registers[rt] & mask) | value;
			break;
		case 35: // lw
			if (rt == 0) break;
			var addr = registers[rs] + simm;
			registers[rt] = this.read32(addr >>> 0);
			break;
		case 36: // lbu
			if (rt == 0) break;
			var addr = registers[rs] + simm;
			var v = this.read8(addr);
			registers[rt] = v >>> 0;
			break;
		case 40: // sb
			var addr = registers[rs] + simm;
			this.write8(addr >>> 0, registers[rt]);
			break;
		case 41: // sh
			var addr = registers[rs] + simm;
			this.write16(addr >>> 0, registers[rt]);
			break;
		case 42: // swl
			var addr = registers[rs] + simm;
			var mask = (addr & 3) ^ 3;
			var value = registers[rt];
			this.write8(addr, value >>> 24);
			if (mask <= 2)
				this.write8(addr - 1, value >>> 16);
			if (mask <= 1)
				this.write8(addr - 2, value >>> 8);
			if (mask == 0)
				this.write8(addr - 3, value >>> 0);
			break;
		case 46: // swr
			var addr = registers[rs] + simm;
			var mask = (addr & 3) ^ 3;
			var value = registers[rt];
			this.write8(addr, value >>> 0);
			if (mask >= 1)
				this.write8(addr + 1, value >>> 8);
			if (mask >= 2)
				this.write8(addr + 2, value >>> 16);
			if (mask == 3)
				this.write8(addr + 3, value >>> 24);
			break;
		case 43: // sw
			var addr = registers[rs] + simm;
			this.write32(addr >>> 0, registers[rt]);
			break;
		case 48: // ll
			// Everything is atomic in our world.
			if (rt == 0) break;
			var addr = registers[rs] + simm;
			registers[rt] = this.read32(addr >>> 0);
			break;
		case 56: // sc
			var addr = registers[rs] + simm;
			this.write32(addr >>> 0, registers[rt]);
			if (rt == 0) break;
			// Everything is atomic in our world.
			registers[rt] = 1;
			break;
		// *** fpu ***
		case 17: // cop1
			var sa = (myInst >>> 6) & 0x1f;
			var rd = (myInst >>> 11) & 0x1f;
			var subOpcodeS = myInst & 0x3f; // special
			registers[STATE_PC] = pc;
			registers[STATE_PENDINGBRANCH] = pending;
			this.runFpuInst(subOpcodeS, rs, rt, rd, sa, simm);
			pc = registers[STATE_PC];
			pending = registers[STATE_PENDINGBRANCH];
			break;
		case 49: // lwc1
			var addr = registers[rs] + simm;
			registers[32 + rt] = this.read32(addr >>> 0);
			break;
		case 53: // ldc1
			// TODO: fail on non-even rt?
			var addr = registers[rs] + simm;
			registers[32 + rt] = this.read32(addr >>> 0);
			registers[33 + rt] = this.read32((addr + 4) >>> 0);
			break;
		case 57: // swc1
			var addr = registers[rs] + simm;
			this.write32(addr >>> 0, registers[32 + rt]);
			break;
		case 61: // sdc1
			// TODO: fail on non-even rt?
			var addr = registers[rs] + simm;
			this.write32(addr >>> 0, registers[32 + rt]);
			this.write32((addr + 4) >>> 0, registers[33 + rt]);
			break;
		default:
			// coprocessor is 0100zz, i.e. 16 t/m 31
			if (opcode >= 16 && opcode < 31 || opcode == 53 || opcode == 54 || opcode == 55 || opcode == 61 || opcode == 62 || opcode == 63) {
				throw Error("unsupported coproc opcode " + opcode);
				break;
			}
			throw new Error("bad instruction, opcode " + opcode);
		}

		if (!this.running) {
			if (!this.exited) {
				registers[STATE_PC] = oldpc;
				registers[STATE_PENDINGBRANCH] = oldpending;
			}
			return insts;
		}

		} // end of instruction loop

		registers[STATE_PC] = pc;
		registers[STATE_PENDINGBRANCH] = pending;

		return maxInsts;
	};
}

