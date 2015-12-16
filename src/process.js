function Process() {
	// note: buffers always initialized to zero

	// Registers: MIPS has 32.
	this.registersBuffer = new ArrayBuffer(32 * 4);
	this.registers = new Uint32Array(this.registersBuffer);

	// Registers: Plus the PC, and we handle delayed branches here too.
	this.pc = 0;
	// We don't allow mappings at NULL.
	this.pendingBranch = 0;

	// To simplify blocking system calls, we store these so we can revert back.
	// (The real kernel also re-executes branches; see kernel/branch.c)
	this.oldpc = 0;
	this.oldPendingBranch = 0;

	// Registers: Plus the lo/hi ones.
	this.resultLow = 0;
	this.resultHigh = 0;

	this.createMaps = function() {
		this.registers = new Uint32Array(this.registersBuffer);
		this.mem8 = new Uint8Array(this.memory);
		this.mem32 = new Uint32Array(this.memory);
		this.pagemap = new Uint16Array(this.pagemapBuffer);
	}

	this.initMemory = function() {
		// Allocate 16mb RAM for now.
		this.memory = new ArrayBuffer(1024 * 1024 * 16);

		// 64kB "pages", 2gb userspace
		this.pagemapBuffer = new ArrayBuffer(32768 * 2);
		this.nextAvailPage = 1; // FIXME: write an allocator
		this.mmapHackStart = 0x8000000;

		this.brk = 0;
		this.tlsAddr = 0;

		this.createMaps();
	}

	this.initMemory();

	this.exitCallbacks = [];

	this.fds = [];
if (typeof window == 'undefined') {
	// node.js
	this.fds[0] = new StreamBackedFile(process.stdin, null);
	this.fds[1] = new StreamBackedFile(null, process.stdout);
	this.fds[2] = new StreamBackedFile(null, process.stderr);
} else {
	// browser
	this.fds[0] = new TerminalBackedFile(terminalObj);
	this.fds[1] = this.fds[0];
	this.fds[2] = this.fds[0];
}

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

	this.cwd = "/";

	// Attempt at optimisation.
	this.optOldPage = 0xfffffff >>> 0;
	this.optOldAddr = 0xfffffff >>> 0;

	this.cloneFrom = function(source) {
		// Caller is responsible for setting pid/ppid.
		this.pc = source.pc;
		this.pendingBranch = source.pendingBranch;
		this.oldpc = source.oldpc;
		this.oldPendingBranch = source.oldPendingBranch;

		// XXX
		this.nextAvailPage = source.nextAvailPage;
		this.mmapHackStart = source.mmapHackStart;

		this.registersBuffer = source.registersBuffer.slice(0);
		this.memory = source.memory.slice(0);
		this.pagemapBuffer = source.pagemapBuffer.slice(0);
		this.createMaps();

		this.resultLow = source.resultLow;
		this.resultHigh = source.resultHigh;

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

		// TODO: ids
	}

	this.closeFds = function() {
		for (var n = 0; n < this.fds.length; ++n) {
			if (this.fds[n])
				this.fds[n].close();
		}
	}

	this.read32 = function(addr) {
		// FIXME 
		var mapped = this.translate(addr);
		var v = this.mem8[mapped];
		if ((addr & 0x03) == 0x0) {
			// TODO: We could also just use mem32...
			v += this.mem8[mapped + 1] << 8;
			v += this.mem8[mapped + 2] << 16;
			v += this.mem8[mapped + 3] << 24;
		} else {
			v += this.mem8[this.translate(addr + 1)] << 8;
			v += this.mem8[this.translate(addr + 2)] << 16;
			v += this.mem8[this.translate(addr + 3)] << 24;
		}
		if (debug) console.log("read " + addr.toString(16) + " (" + v.toString(16) + ")");
		return v;
	}

	this.read16 = function(addr) {
		// FIXME 
		var v = this.mem8[this.translate(addr)];
		v += this.mem8[this.translate(addr + 1)] << 8;
		return v;
	}

	this.write8 = function(addr, value) {
		// FIXME 
		this.mem8[this.translate(addr)] = value;
	}

	this.write16 = function(addr, value) {
		// FIXME 
		this.mem8[this.translate(addr)] = value & 0xff;
		this.mem8[this.translate(addr + 1)] = (value >>> 8) & 0xff;
	}

	this.write32 = function(addr, value) {
		if (debug) console.log("write " + addr.toString(16) + " (" + value.toString(16) + ")");
		// FIXME
		this.mem8[this.translate(addr)] = value & 0xff;
		this.mem8[this.translate(addr + 1)] = (value >>> 8) & 0xff;
		this.mem8[this.translate(addr + 2)] = (value >>> 16) & 0xff;
		this.mem8[this.translate(addr + 3)] = (value >>> 24) & 0xff;
	}

	this.copyToUser = function(addr, data, isString) {
		for (var n = 0; n < data.length; ++n)
			this.mem8[this.translate(addr++)] = data[n].charCodeAt(0);
		if (isString)
			this.mem8[this.translate(addr++)] = 0;
	}

	this.stringFromUser = function(addr) {
		// FIXME
		var str = "";
		while (true) {
			var v = this.mem8[this.translate(addr++)];
			if (v == 0) break;
			str += String.fromCharCode(v);
		}
		return str;
	}

	this.loadElf = function(buffer, argv, envp) {
		var elf = new ELFFile(buffer);
		var u8a = new Uint8Array(buffer);
		var u32a = new Uint32Array(buffer);

		var baseaddr = undefined;

		var load_bias = 0x200000;

		// TODO: We just quietly assume headers/sections are aligned.
		for (var p = 0; p < elf.headers.length; ++p) {
			var header = elf.headers[p];

			// TODO: think about this
			// We move dynamic programs by a fixed offset to get them out of the way.
			if (elf.objType == ET_DYN)
				header.pVAddr += load_bias;

			switch (header.pType) {
			case 1: // PT_LOAD
				if (baseaddr == undefined)
					baseaddr = header.pVAddr - header.pOffset;
				for (var b = 0; b < header.pFileSz; ++b) {
					// FIXME: allocate memory :)
					var pageId = this.pagemap[(header.pVAddr + b) >>> 16];
					if (pageId == 0)
						this.pagemap[(header.pVAddr + b) >>> 16] = this.nextAvailPage++;
					this.mem8[this.translate(header.pVAddr + b)] = u8a[header.pOffset + b];
				}
				for (var b = header.pFileSz; b < header.pMemSz; ++b) {
					var pageId = this.pagemap[(header.pVAddr + b) >>> 16];
					if (pageId == 0)
						this.pagemap[(header.pVAddr + b) >>> 16] = this.nextAvailPage++;
				}
				break;
			case 0x70000000: // PT_MIPS_REGINFO
				// The 6th value is the initial value of the gp register.
				this.registers[28] = u32a[(header.pOffset >>> 2) + 5];
				break;
			}
		}

		var interp_baseaddr = baseaddr;

		// XXX: see above
		if (elf.objType == ET_DYN)
			elf.entryPoint += load_bias;

		this.pc = elf.entryPoint;
		this.pendingBranch = 0;

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

				if (interp_baseaddr == baseaddr)
					interp_baseaddr = header.pVAddr - header.pOffset;

				switch (header.pType) {
				case 1: // PT_LOAD
					for (var b = 0; b < header.pFileSz; ++b) {
						// FIXME: allocate memory :)
						var pageId = this.pagemap[(header.pVAddr + b) >>> 16];
						if (pageId == 0)
							this.pagemap[(header.pVAddr + b) >>> 16] = this.nextAvailPage++;
						this.mem8[this.translate(header.pVAddr + b)] = iu8a[header.pOffset + b];
					}
					for (var b = header.pFileSz; b < header.pMemSz; ++b) {
						var pageId = this.pagemap[(header.pVAddr + b) >>> 16];
						if (pageId == 0)
							this.pagemap[(header.pVAddr + b) >>> 16] = this.nextAvailPage++;
					}
				break;
				}
			}

			// XXX: ugly hack again (see above)
			this.pc = elf_interp.entryPoint + 0x10000;
		}

		// FIXME: allocate heap, stack
		this.brk = 0xb000000;
		for (var p = 0; p < 10; ++p)
			this.pagemap[0xb00 + p] = this.nextAvailPage++;

		var sp = 0xc00fff0;
		for (var p = 0; p < 5; ++p)
			this.pagemap[0xc00 + p] = this.nextAvailPage++;

		// XXX hack for args
		var dummy = 0xa000000;
		this.pagemap[0xa00] = this.nextAvailPage++;
		var argp = new Array();
		var envpp = new Array();

		for (var a = 0; a < argv.length; ++a) {
			argp.push(dummy);
			var tmp = argv[a];
			for (var n = 0; n < tmp.length; ++n)
				this.mem8[this.translate(dummy++)] = tmp[n].charCodeAt(0);
			this.mem8[this.translate(dummy++)] = 0;
		}
		for (var a = 0; a < envp.length; ++a) {
			envpp.push(dummy);
			var tmp = envp[a];
			for (var n = 0; n < tmp.length; ++n)
				this.mem8[this.translate(dummy++)] = tmp[n].charCodeAt(0);
			this.mem8[this.translate(dummy++)] = 0;
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
		this.write32(sp, 31); // AT_EXECFN
		sp += 4;
		this.write32(sp, 0x100); // XXX: hack
		sp += 4;
		this.write32(sp, 0); // AT_NULL
		sp += 4;
		this.write32(sp, 0);
		sp += 4;
	}

	this.syscall = function() {
		var ret = 0;

		var syscallnr = this.registers[2];

		if (!syscalls[syscallnr])
			throw Error("syscall " + syscallnr + " not implemented");
		if (showSystemCalls)
			console.log("pid " + this.pid + ": syscall " + syscallnr + " (" + syscalls[syscallnr].name + ")");

		var ret = syscalls[syscallnr](this);

		if (!this.running)
			return;

		// return value in v0, error flag in a3 (see kernel/scall32-o32.S)
		if ((ret >> 0) < 0) {
			this.registers[2] = -ret;
			this.registers[7] = 1;
		} else {
			this.registers[2] = ret;
			this.registers[7] = 0;
		}
	};

	this.translate = function(addr) {
		// FIXME: make sure this can't happen
		if (addr < 0)
			throw Error("you broke it address " + addr.toString(16));
		if (addr >= 0x80000000)
			throw Error("bad address " + addr.toString(16));
		var pageId = this.pagemap[addr >>> 16];
		if (pageId == 0)
			throw Error("bad address " + addr.toString(16));
		return (pageId << 16) + (addr & 0xffff);
	}

	this.runOneInst = function() {
		// If this.optOldAddr contains the higher bits of PC, we're still using the same page.
		// In this case, we can use a heap address directly and avoid a call to translate.
		// XXX: This doesn't account for page table changing from under us, etc.
		var pcaddr = this.optOldPage + (this.pc & 0xffff);
		if ((this.pc >>> 16) != this.optOldAddr) {
			pcaddr = this.translate(this.pc);
			this.optOldPage = pcaddr & 0xffff0000;
			this.optOldAddr = this.pc >>> 16;
		}

		var myInst = this.mem32[pcaddr >>> 2];

		var opcode = myInst >>> 26;
		var subOpcodeR = (myInst >>> 16) & 0x1f; // regimm
		var subOpcodeS = myInst & 0x3f; // special
		var rs = (myInst >>> 21) & 0x1f;
		var rt = (myInst >>> 16) & 0x1f;
		var rd = (myInst >>> 11) & 0x1f;
		var sa = (myInst >>> 6) & 0x1f;
		var imm = myInst & 0xffff;
		var simm = imm;
		if (imm & 0x8000)
			simm = -(0x10000 - imm);

		if (debug) {
			console.log("@" + this.pc.toString(16) + ": inst " + opcode + " (" + myInst.toString(16) + ")" + ", " + subOpcodeS);
			var debugInfo = "";
			for (var n = 0; n < 32; ++n)
				debugInfo = debugInfo + this.registers[n].toString(16) + " ";
			console.log(debugInfo);
		}

		this.oldpc = this.pc;
		this.pc += 4;

		// delayed branching
		if (this.pendingBranch) {
			this.pc = this.pendingBranch >>> 0;
			this.oldPendingBranch = this.pendingBranch;
			this.pendingBranch = 0;
		} else
			this.oldPendingBranch = 0;

		switch (opcode) {
		case 0: // special
			switch (subOpcodeS) {
			case 0: // sll
				if (rd == 0) break;
				this.registers[rd] = (this.registers[rt] << sa) >>> 0;
				break;
			case 2: // srl
				if (rd == 0) break;
				this.registers[rd] = this.registers[rt] >>> sa;
				break;
			case 3: // sra
				if (rd == 0) break;
				this.registers[rd] = (this.registers[rt] >> 0) >> (sa >> 0);
				break;
			case 4: // sllv
				if (rd == 0) break;
				this.registers[rd] = this.registers[rt] << this.registers[rs];
				break;
			case 6: // srlv
				if (rd == 0) break;
				this.registers[rd] = this.registers[rt] >> this.registers[rs];
				break;
			case 7: // srav
				if (rd == 0) break;
				this.registers[rd] = (this.registers[rt] >> 0) >> (this.registers[rs] >> 0);
				break;
			case 8: // jr
				this.pendingBranch = this.registers[rs];
				if (debug) console.log("--- jmp " + this.pendingBranch.toString(16));
				break;
			case 9: // jalr
				this.pendingBranch = this.registers[rs];
				if (showCalls) console.log(this.pc.toString(16) + " --> call " + this.pendingBranch.toString(16));
				if (rd == 0) break;
				this.registers[rd] = this.pc + 4;
				break;
			case 12: // syscall
				this.syscall();
				break;
			case 13: // break
				throw Error("breakpoint"); // FIXME
				break;
			case 15: // sync
				// There is no shared memory in our world.
				break;
			case 16: // mfhi
				if (rd == 0) break;
				this.registers[rd] = this.resultHigh;
				break;
			case 17: // mthi
				throw Error(); // FIXME
				break;
			case 18: // mflo
				if (rd == 0) break;
				this.registers[rd] = this.resultLow;
				break;
			case 19: // mtlo
				throw Error(); // FIXME
				break;
			case 24: // mult
				// FIXME: this is so wrong (also multResult should be always in the obj..)
				//console.log("mult " + this.registers[rs] + " " + this.registers[rt]);
				/*var result = (this.registers[rt] >> 0) * (this.registers[rs] >> 0);
				this.resultLow = (result & 0xffffffff) >>> 0;
				this.resultHigh = result >>> 32;
				break;*/
			case 25: // multu
				// FIXME: this is so wrong (also multResult should be always in the obj..)
				//console.log("multu " + this.registers[rs] + " " + this.registers[rt]);
				var tl = this.registers[rt] & 0xffff;
				var sl = this.registers[rs] & 0xffff;
				var th = (this.registers[rt] >>> 16) & 0xffff;
				var sh = (this.registers[rs] >>> 16) & 0xffff;
				var low = tl * sl;
				var mid = (th * sl) + (sh * tl);
				var tmp = mid + (low >>> 16);
				this.resultLow = ((mid << 16) + low) >>> 0;
				this.resultHigh = (th * sh) + (tmp >>> 16);
				if (tmp > 0xffffffff) this.resultHigh += 0x10000;
				this.resultHigh = this.resultHigh >>> 0;
				break;
			case 26: // div
				throw Error(); // FIXME
				break;
			case 27: // divu
				if (this.registers[rt] == 0)
					break; // undefined
				this.resultLow = this.registers[rs] / this.registers[rt];
				this.resultHigh = this.registers[rs] % this.registers[rt];
				break;
			case 32: // add
				throw Error(); // FIXME
				break;
			case 33: // addu
				if (rd == 0) break;
				this.registers[rd] = (this.registers[rt] + this.registers[rs]) >>> 0;
				break;
			case 34: // sub
				throw Error(); // FIXME
				break;
			case 35: // subu
				if (rd == 0) break;
				this.registers[rd] = (this.registers[rs] - this.registers[rt]) >>> 0;
				break;
			case 36: // and
				if (rd == 0) break;
				this.registers[rd] = this.registers[rt] & this.registers[rs];
				break;
			case 37: // or
				if (rd == 0) break;
				this.registers[rd] = this.registers[rt] | this.registers[rs];
				break;
			case 38: // xor
				if (rd == 0) break;
				this.registers[rd] = this.registers[rt] ^ this.registers[rs];
				break;
			case 39: // nor
				if (rd == 0) break;
				this.registers[rd] = ~(this.registers[rt] | this.registers[rs]);
				break;
			case 42: // slt
				if (rd == 0) break;
				if ((this.registers[rs] >> 0) < (this.registers[rt] >> 0))
					this.registers[rd] = 1;
				else
					this.registers[rd] = 0;
				break;
			case 43: // sltu
				if (rd == 0) break;
				if (this.registers[rs] < this.registers[rt])
					this.registers[rd] = 1;
				else
					this.registers[rd] = 0;
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
				if (this.registers[rs] == this.registers[rt])
					throw Error("teq");
				break;
			case 53: // tne
				if (this.registers[rs] != this.registers[rt])
					throw Error("tne");
				break;
			default:
				throw new Error("bad special instruction " + subOpcodeS);
			}
			break;
		case 31: // more special
			switch (subOpcodeS) {
			case 59: // rdhwr
				// This is emulated by the kernel.
				switch (rd) {
				case 29:
					// TLS pointer.
					if (rt == 0) break;
					this.registers[rt] = this.tlsAddr;
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
			switch (rt) {
			case 0: // bltz
				if ((this.registers[rs] >> 0) < 0)
					this.pendingBranch = this.pc + (simm << 2);
				break;
			case 1: // bgez
				if ((this.registers[rs] >> 0) >= 0)
					this.pendingBranch = this.pc + (simm << 2);
				break;
			case 16: // bltzal
				// TODO: check
				this.registers[31] = this.pc + 4;
				if ((this.registers[rs] >> 0) < 0) {
					this.pendingBranch = this.pc + (simm << 2);
					if (showCalls) console.log(this.pc.toString(16) + " --> call " + this.pendingBranch.toString(16));
				}
			case 17: // bgezal
				this.registers[31] = this.pc + 4;
				if ((this.registers[rs] >> 0) >= 0) {
					this.pendingBranch = this.pc + (simm << 2);
					if (showCalls) console.log(this.pc.toString(16) + " --> call " + this.pendingBranch.toString(16));
				}
				break;
			default:
				throw new Error("bad regimm instruction " + regimm);
			}
			break;
		case 2: // j
			var target = myInst & 0x3ffffff;
			//if (target & 0x2000000)
			//	target = -(0x4000000 - target);
			this.pendingBranch = (this.pc & 0xf0000000) | (target << 2);
			break;
		case 3: // jal
			var target = myInst & 0x3ffffff;
			//if (target & 0x2000000)
			//	target = -(0x4000000 - target);
			this.pendingBranch = (this.pc & 0xf0000000) | (target << 2);
			this.registers[31] = this.pc + 4;
			if (debug) console.log("--> call " + this.pendingBranch.toString(16));
			break;
		case 4: // beq
			if (this.registers[rs] == this.registers[rt])
				this.pendingBranch = this.pc + (simm << 2);
			break;
		case 17: // beql
			if (this.registers[rs] == this.registers[rt])
				this.pendingBranch = this.pc + (simm << 2);
			else
				this.pc += 4;
			break;
		case 5: // bne
			if (this.registers[rs] != this.registers[rt])
				this.pendingBranch = this.pc + (simm << 2);
			break;
		case 18: // bnel
			if (this.registers[rs] != this.registers[rt])
				this.pendingBranch = this.pc + (simm << 2);
			else
				this.pc += 4;
			break;
		case 6: // blez
			if ((this.registers[rs] >> 0) <= 0)
				this.pendingBranch = this.pc + (simm << 2);
			break;
		case 22: // blezl
			if ((this.registers[rs] >> 0) <= 0)
				this.pendingBranch = this.pc + (simm << 2);
			else
				this.pc += 4;
			break;
		case 7: // bgtz
			if ((this.registers[rs] >> 0) > 0)
				this.pendingBranch = this.pc + (simm << 2);
			break;
		case 23: // bgtzl
			if ((this.registers[rs] >> 0) > 0)
				this.pendingBranch = this.pc + (simm << 2);
			else
				this.pc += 4;
			break;
		case 8: // addi
			throw Error(); // FIXME
			break;
		case 9: // addiu
			if (rt == 0) break;
			this.registers[rt] = (this.registers[rs] + simm) >>> 0;
			break;
		case 10: // slti
			if (rt == 0) break;
			if (this.registers[rs] < simm)
				this.registers[rt] = 1;
			else
				this.registers[rt] = 0;
			break;
		case 11: // sltiu
			if (rt == 0) break;
			if (this.registers[rs] < imm)
				this.registers[rt] = 1;
			else
				this.registers[rt] = 0;
			break;
		case 12: // andi
			if (rt == 0) break;
			this.registers[rt] = this.registers[rs] & imm;
			break;
		case 13: // ori
			if (rt == 0) break;
			this.registers[rt] = this.registers[rs] | imm;
			break;
		case 14: // xori
			if (rt == 0) break;
			this.registers[rt] = this.registers[rs] ^ imm;
			break;
		case 15: // lui
			// assert(rs == 0);
			if (rt == 0) break;
			this.registers[rt] = imm << 16;
			break;
		case 32: // lb
			if (rt == 0) break;
			var addr = this.registers[rs] + simm;
			var v = this.mem8[this.translate(addr >>> 0)];
			if (v & 0x80) v |= 0xffffff00;
			this.registers[rt] = v;
			break;
		case 33: // lh
			if (rt == 0) break;
			var addr = this.registers[rs] + simm;
			var v = this.read16(addr >>> 0);
			if (v & 0x8000) v |= 0xffff0000;
			this.registers[rt] = v;
			break;
		case 37: // lhu
			if (rt == 0) break;
			var addr = this.registers[rs] + simm;
			var v = this.read16(addr >>> 0);
			this.registers[rt] = v;
			break;
		case 34: // lwl
			if (rt == 0) break;
			var addr = (this.registers[rs] + simm) >>> 0;
			var mask = addr & 0x3;
			addr = addr & 0xfffffffc;
			var value = this.read32(addr);

			// lwl is usually called with address+3, so we want to take the data with
			// higher addresses (on little-endian: the least-significant bits)

			// Take the aligned bytes starting here (mask 0 = 1, mask 3 = all of them).
			if (mask == 3) {
				this.registers[rt] = value;
				break;
			}

			// Take the least-significant bits, which become the most-significant ones.
			value = value << ((3 - mask) * 8);

			// Use only the least-significant bits in the register.
			mask = (0xffffffff >>> ((1 + mask) * 8)) >>> 0;
			this.registers[rt] = (this.registers[rt] & mask) | value;
			//console.log("lwl " + value.toString(16) + " " + mask + " " + addr.toString(16));
			break;
		case 38: // lwr
			if (rt == 0) break;
			var addr = (this.registers[rs] + simm) >>> 0;
			var mask = addr & 0x3;
			addr = addr & 0xfffffffc;
			var value = this.read32(addr);

			// Take the aligned bytes ending here (mask 0 = all, 1 = 3 of them, ...).
			if (mask == 0) {
				this.registers[rt] = value;
				break;
			}

			// Take the most-significant bits, which become the least-significant ones.
			value = value >>> (mask * 8);

			// Use only the most-significant bits in the register.
			mask = (0xffffffff << ((4 - mask) * 8)) >>> 0;
			this.registers[rt] = (this.registers[rt] & mask) | value;
			//console.log("lwr " + value.toString(16) + " " + mask + " " + addr.toString(16));
			break;
		case 35: // lw
			if (rt == 0) break;
			var addr = this.registers[rs] + simm;
			this.registers[rt] = this.read32(addr >>> 0);
			break;
		case 36: // lbu
			if (rt == 0) break;
			var addr = this.registers[rs] + simm;
			var v = this.mem8[this.translate(addr >>> 0)];
			this.registers[rt] = v;
			break;
		case 40: // sb
			var addr = this.registers[rs] + simm;
			this.write8(addr >>> 0, this.registers[rt]);
			break;
		case 41: // sh
			var addr = this.registers[rs] + simm;
			this.write16(addr >>> 0, this.registers[rt]);
			break;
		case 42: // swl
			// FIXME: verify
			var addr = this.registers[rs] + simm;
			var mask = addr & 0x3;
			addr = addr & 0xfffffffc;
			// We have the most-significant bits and we want to make them the least-significant ones.
			var value = this.registers[rt] >>> ((3 - mask) * 8);
			if (mask == 3) // agh js
				mask = 0;
			else
				mask = 0xffffffff << ((1 + mask) * 8);
			value = (this.read32(addr >>> 0) & mask) | value;
			this.write32(addr >>> 0, value);
			break;
		case 46: // swr
			// FIXME: verify
			var addr = this.registers[rs] + simm;
			var mask = addr & 0x3;
			addr = addr & 0xfffffffc;
			// We have the least-significant bits and we want to make them the most-significant ones.
			var value = (this.registers[rt] << (mask * 8));
			if (mask != 0) // agh js
				mask = 0xffffffff >>> ((4 - mask) * 8);
			value = (this.read32(addr >>> 0) & mask) | value;
			this.write32(addr >>> 0, value);
			break;
		case 43: // sw
			var addr = this.registers[rs] + simm;
			this.write32(addr >>> 0, this.registers[rt]);
			break;
		case 48: // ll
			// Everything is atomic in our world.
			if (rt == 0) break;
			var addr = this.registers[rs] + simm;
			this.registers[rt] = this.read32(addr >>> 0);
			break;
		case 56: // sc
			var addr = this.registers[rs] + simm;
			this.write32(addr >>> 0, this.registers[rt]);
			if (rt == 0) break;
			// Everything is atomic in our world.
			this.registers[rt] = 1;
			break;
		default:
			// coprocessor is 0100zz, i.e. 16 t/m 31
			if (opcode >= 16 && opcode < 31 || opcode == 53 || opcode == 54 || opcode == 55 || opcode == 61 || opcode == 62 || opcode == 63) {
				if (debug) console.log("ignoring coproc opcode " + opcode);
				break;
			}
			throw new Error("bad instruction, opcode " + opcode);
		}

		if (!this.running && !this.exited) {
			this.pc = this.oldpc;
			this.pendingBranch = this.oldPendingBranch;
		}

		if (this.running)
			instCount++;
	};
}

