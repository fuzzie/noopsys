function sys_brk(proc) {
	if (proc.registers[4] == 0)
		return proc.brk;
	else
		return proc.registers[4]; // XXX
}

function sys_set_thread_area(proc) {
	proc.tlsAddr = proc.registers[4];
	return 0;
}

function sys_getpid(proc) {
	return proc.pid;
}

function sys_gettid(proc) {
	// FIXME
	return proc.pid;
}

function sys_setpgid(proc) {
	// FIXME
	return 0;
}

function sys_getppid(proc) {
	return proc.ppid;
}

function sys_getpgrp(proc) {
	// FIXME
	return 0;
}

function sys_geteuid(proc) {
	return proc.euid;
}

function sys_getegid(proc) {
	return proc.egid;
}

function sys_setuid(proc) {
	var uid = proc.registers[4];

	// TODO: EPERM if not root and not allowed

	proc.uid = uid;

	return 0;
}

function sys_getuid(proc) {
	return proc.uid;
}

function sys_setgid(proc) {
	var gid = proc.registers[4];

	// TODO: EPERM if not root and not allowed

	proc.gid = gid;

	return 0;
}

function sys_getgid(proc) {
	return proc.gid;
}

function sys_getgroups(proc) {
	// TODO
	return 0;
}

function sys_setgroups(proc) {
	// TODO
	return 0;
}

function sys_readlink(proc) {
	var filename = proc.stringFromUser(proc.registers[4]);
	var buf = proc.registers[5];
	var bufsiz = proc.registers[6];
	var node = getNodeForPath(filename, proc, true);
	if (typeof node == 'number')
		return node;
	if (!S_ISLNK(node.mode))
		return -EINVAL;

	// No null terminator required.
	if (node.data.length < bufsiz)
		bufsiz = node.data.length;
	proc.copyToUser(buf, node.data.slice(0, bufsiz), false);

	return bufsiz;
}

function sys_ioctl(proc) {
	var fd = proc.registers[4];
	var request = proc.registers[5];
	var addr = proc.registers[6];
	// FIXME: -ENOTTY breaks everything :p
	//console.log("ioctl " + request.toString(16));
	return 0;
}

function sys_mmap_core(proc, ispgoffset) {
	// MIPS ABI is different.
	var addr = proc.registers[4];
	var len = proc.registers[5];
	var prot = proc.registers[6];
	var flags = proc.registers[7];
	var fd = proc.read32(proc.registers[29] + 16);
	var offset = proc.read32(proc.registers[29] + 20);
	if (ispgoffset)
		offset = offset * 4096; // We don't care about large files.

	if (!proc.fds[fd]) {
		return -EBADF;
	}
	var file = proc.fds[fd];
	if (!file.node)
		return -EACCES;

	var isPrivate = (flags & MAP_PRIVATE) == MAP_PRIVATE;
	var isShared = (flags & MAP_SHARED) == MAP_SHARED;

	if (flags & MAP_ANONYMOUS) {
		console.log("anon");
		return -ENODEV; // go away
	}

	// FIXME: the rest
	//console.log("mmap: map fd " + fd + " at " + addr.toString(16) + " (" + len + " bytes)");

	var pages = ((len + 0xffff) / 0x10000) >>> 0;

	// take a memory region
	var start = proc.mmapHackStart;
	if (addr) {
		// XXX: ugh
		//if (addr < start)
		//	throw Error("mmap with non-zero addr"); // TODO
		start = addr;
	}
	// TODO: ugh
	// We try to leave a gap between mappings to make debugging easier.
	if (start + 0x10000*(pages+2) > proc.mmapHackStart)
		proc.mmapHackStart = start + 0x10000*(pages + 2);

	// reserve the pages
	for (var n = 0; n < pages; ++n) {
		var pageid = (start>>16) + n;
		//if (proc.pagemap[pageid])
		//	throw Error("page " + pageid + " already allocated");
		if (!proc.pagemap[pageid])
			proc.pagemap[pageid] = proc.nextAvailPage++;
	}

	// copy the data (alas)
	// XXX
	var u8a = new Uint8Array(file.node.data);
	for (var n = 0; n < len; ++n) {
		if (offset + n > file.node.size)
			break;
		proc.mem8[proc.translate(start + n)] = u8a[offset + n];
	}

	return start;
}

function sys_mmap(proc) {
	return sys_mmap_core(proc, false);
}

function sys_mmap2(proc) {
	return sys_mmap_core(proc, true);
}

function sys_munmap() {
	// FIXME
	return 0;
}

function sys_madvise(proc) {
	// We don't care.
	return 0;
}

function sys_mprotect() {
	// FIXME
	return 0;
}

function do_lseek(proc, fd, offset, whence) {
	if (!proc.fds[fd]) {
		return -EBADF;
	}
	var file = proc.fds[fd];

	var newOffset = file.pos;
	// FIXME
	switch (whence) {
	case SEEK_CUR:
		newOffset = newOffset + offset;
		break;
	case SEEK_SET:
		newOffset = offset;
		break;
	case SEEK_END:
		newOffset = file.node.size + offset; // XXX
		break;
	default:
		return -EINVAL;
	}

	// XXX
	if (newOffset < 0)
		return -EINVAL;
	file.pos = newOffset;

	return file.pos;
}

function sys_lseek(proc) {
	var fd = proc.registers[4];
	var offset = proc.registers[5] >> 0;
	var whence = proc.registers[6];

	return do_lseek(proc, fd, offset, whence);
}

function sys__llseek(proc) {
	var fd = proc.registers[4];
	var offset_high = proc.registers[5] >> 0;
	var offset_low = proc.registers[6] >> 0;
	var result = proc.registers[7];
	var whence = proc.read32(proc.registers[29] + 16);

	if (offset_high != 0xffffffff && offset_high != 0)
		return -ERANGE; // Linux doesn't allow this, but..

	var ret = do_lseek(proc, fd, offset_low, whence);
	if (ret < 0)
		return ret;

	proc.write32(result, ret);
	proc.write32(result + 4, 0);
	return 0;
}

function sys_read(proc) {
	var fd = proc.registers[4];
	if (!proc.fds[fd]) {
		return -EBADF;
	}
	var addr = proc.registers[5];
	var length = proc.registers[6];
	var file = proc.fds[fd];
	var ret = file.read(proc, length);
	if (ret > length)
		ret = length;
	if (ret > 0) {
		if (typeof file.data == 'string') // XXX :-(
			for (var n = 0; n < ret; ++n) {
				proc.mem8[proc.translate(addr + n)] = file.data.charCodeAt(n);
			}
		else
			for (var n = 0; n < ret; ++n) {
				proc.mem8[proc.translate(addr + n)] = file.data[n];
			}
		file.data = file.data.slice(ret); // XXX
	}
	return ret;
}

function sys_write(proc) {
	// FIXME: sanity-check fd
	var fd = proc.registers[4];
	var addr = proc.registers[5];
	var length = proc.registers[6];
	var str = "";
	for (var n = 0; n < length; ++n) {
		str += String.fromCharCode(proc.mem8[proc.translate(addr + n)]);
	}
	//console.log("write '" + str + "' to " + fd + " (" + length + " chars)");
	// XXX
	var ret = proc.fds[fd].write(proc, str);
	return ret;
}

function sys_poll(proc) {
	var fds = proc.registers[4];
	var nfds = proc.registers[5];
	var timeout_ts = proc.registers[6];
	var sigmask = proc.registers[7];
	var ret = 0;

	for (var n = 0; n < nfds; ++n) {
		var fd = proc.read32(fds + 8*n);

		var revents = POLLNVAL;
		if (proc.fds[fd]) {
			revents = 0;

			// Note: Linux's ppoll/poll only return POLLIN/POLLRDNORM
			// and POLLOUT/POLLRDNORM.
			// TODO: Should we set the RD ones too?
			var events = proc.read16(fds + 8*n + 4);

			// FIXME: :-)
			if ((events & POLLIN) == POLLIN)
				revents |= POLLIN;
			if ((events & POLLOUT) == POLLOUT)
				revents |= POLLOUT;
		}

		proc.write16(fds + 8*n + 6, revents);
		if (revents)
			ret++;
	}

	return ret;
}

// FIXME: we really need to rethink fds
function sys_dup(proc) {
	// FIXME
	var fd = proc.registers[4];
	if (!proc.fds[fd]) {
		return -EBADF;
	}
	proc.fds[fd].refs++; // XXX: super temp hack for pipes
	proc.fds.push(proc.fds[fd]);
	var ret = proc.fds.length - 1;
	return ret;
}

function sys_dup2(proc) {
	// FIXME
	// TODO: close?
	var oldfd = proc.registers[4];
	var newfd = proc.registers[5];
	//console.log("dup2: " + oldfd + " -> " + newfd);
	if (oldfd == newfd)
		return newfd;
	if (!proc.fds[oldfd]) {
		return -EBADF;
	}
	var fd = proc.fds[oldfd];
	if (proc.fds[newfd])
		proc.fds[newfd].close();
	fd.refs++; // XXX: super temp hack for pipes
	proc.fds[newfd] = fd;

	return newfd;
}

function sys_pipe(proc) {
	var outPipe = new PipeWriter();
	var inPipe = new PipeReader(outPipe);
	outPipe.src = inPipe; // XXX: design rethink

	proc.fds.push(outPipe);
	var outfd = proc.fds.length-1;
	proc.fds.push(inPipe);
	var infd = proc.fds.length-1;

	// Linux/MIPS has a special hack, just for pipe.
	proc.registers[3] = outfd;
	return infd;
}

function sys_unlink(proc) {
	// TODO
	return 0;
}

function sys_open(proc) {
	// FIXME
	var filename = proc.stringFromUser(proc.registers[4]);
	var flags = proc.registers[5];
	var mode = proc.registers[6];

	//console.log("open: " + filename);

	var stopOnLinks = (flags & O_NOFOLLOW) == O_NOFOLLOW; // TODO: fix return value
	var node = getNodeForPath(filename, proc, stopOnLinks);

	if (((flags & (O_EXCL|O_CREAT)) == (O_EXCL|O_CREAT)) && (typeof node != 'number'))
		return -EEXIST;

	if ((node == -ENOENT) && (flags & O_CREAT)) {
		var path = filename.split("/");
		var basename = path.pop();
		var pathname = path.join("/");
		// XXX: do this properly (this is bad for various reasons)
		var parentnode = getNodeForPath(pathname, proc, stopOnLinks);
		//console.log("creating " + basename + " in " + pathname);
		if (typeof parentnode == 'number')
			return -ENOENT; // TODO: right?
		node = new memFSNode("", parentnode);
		node.mode = mode;
		parentnode.getChildren()[basename] = node;
	}
	if (typeof node == 'number')
		return node;

	// XXX: ugh
	if (flags & O_TRUNC)
		node.data = "";

	proc.fds.push(new memFSBackedFile(node));
	var fd = proc.fds.length-1;
	return fd;
}

function sys_close(proc) {
	var fd = proc.registers[4];
	if (!proc.fds[fd])
		return -EBADF;
	proc.fds[fd].close();
	proc.fds[fd] = null;
	return 0;
}

function sys_openat(proc) {
	// FIXME
	var dirfd = proc.registers[4];
	var filename = proc.stringFromUser(proc.registers[5]);
	var mode = proc.registers[6];
	//console.log("openat: " + filename);
	var node = getNodeForPath(filename, proc);
	if (typeof node == 'number')
		return node;
	proc.fds.push(new memFSBackedFile(node));
	var fd = proc.fds.length-1;
	return fd;
}

function sys_getcwd(proc) {
	var buffer = proc.registers[4];
	var length = proc.registers[5];

	var path = proc.cwd;

	var ret = buffer;
	if (path.length + 1 > length) {
		ret = -ERANGE;
	} else {
		proc.copyToUser(buffer, path, true);
	}
	return ret;
}

function sys_chdir(proc) {
	// FIXME: just a bunch of hacks, doesn't resolve path :)
	var filename = proc.stringFromUser(proc.registers[4]);
	var node = getNodeForPath(filename, proc);
	if (typeof node == 'number')
		return node;
	if (filename[0] == '/')
		proc.cwd = filename;
	else if (filename === '.')
		return 0;
	else if (filename === '..') {
		if (proc.cwd != '/') {
			entries = proc.cwd.split('/');
			entries.pop();
			proc.cwd = entries.join('/');
			if (!proc.cwd.length)
				proc.cwd = '/';
		}
	} else {
		// sorry :p
		if (proc.cwd[proc.cwd.length-1] != '/')
			proc.cwd = proc.cwd + '/';
		proc.cwd = proc.cwd + filename;
	}
	return 0;
}

function do_stat64(proc, followLinks) {
	var filename = proc.stringFromUser(proc.registers[4]);
	var node = getNodeForPath(filename, proc, !followLinks);
	if (typeof node == 'number')
		return node;

	return do_stat64_core(proc, node);
}

function do_stat64_core(proc, node) {
	var buf = proc.registers[5];
	// FIXME
	proc.write32(buf + 0, 1); // st_dev, TODO
	// <3 padding bytes>
	proc.write32(buf + 16, node.inode); // st_ino, TODO
	proc.write32(buf + 20, 0); // st_ino (high bits)
	proc.write32(buf + 24, node.mode); // st_mode
	proc.write32(buf + 28, 1); // st_nlink, TODO
	proc.write32(buf + 32, 0); // st_uid, TODO
	proc.write32(buf + 36, 0); // st_gid, TODO
	proc.write32(buf + 40, 0); // st_rdev, TODO
	// <3 padding bytes>
	proc.write32(buf + 56, node.size); // st_size, TODO
	proc.write32(buf + 60, 0); // st_size (high bits)
	proc.write32(buf + 64, 0); // st_atime, TODO
	// <pad>
	proc.write32(buf + 72, 0); // st_mtime, TODO
	// <pad>
	proc.write32(buf + 80, 0); // st_ctime, TODO
	// <pad>
	proc.write32(buf + 88, 0); // st_blksize, TODO
	// <pad>
	proc.write32(buf + 96, 0); // st_blocks, TODO
	proc.write32(buf + 100, 0); // st_blocks (high bits)

	return 0;
}

function sys_stat64(proc) {
	return do_stat64(proc, true);
}

function sys_lstat64(proc) {
	return do_stat64(proc, false);
}

function sys_fstat64(proc) {
	var fd = proc.registers[4];
	var fdo = proc.fds[fd];
	if (!fdo || !fdo.node)
		return -EBADF;
	// XXX
	return do_stat64_core(proc, fdo.node);
}

function sys_getdents64(proc) {
	var fd = proc.registers[4];
	var dirp = proc.registers[5];
	var count = proc.registers[6];
	var fdo = proc.fds[fd];
	if (!fdo)
		return -EBADF;
	var node = fdo.node;
	// TODO: better check?
	if (!S_ISDIR(node.mode))
		return -ENOTDIR;
	// TODO: permissions check


	var ret = 0;
	// TODO: probably this should be done by the node, to allow procfs etc
	// FIXME: underlying design is bad here (can't use dict)
	var children = node.getChildren();
	keys = Object.keys(children);
	for (var n = 0; n < keys.length; ++n) {
		if (n < fdo.pos)
			continue;
		fdo.pos++;

		var name = keys[n];
		var child = children[name];
		/* dirent: long d_ino, long offset to next (from start of whole thing), long reclen, filename, char zero, char d_type */
		var neededSize = 19 + (name.length + 1);
		if (count < neededSize) {
			if (count == 0)
				return -EINVAL;
			break;
		}
		count = count - neededSize;
		ret = ret + neededSize;
 		// XXX
		proc.write32(dirp, child.inode); // d_ino
		proc.write32(dirp + 4, 0); // d_ino (high bits)
		proc.write32(dirp + 8, ret); // d_off (to next)
		proc.write32(dirp + 12, ret); // d_off (high bits)
		proc.write16(dirp + 16, neededSize);
		proc.write8(dirp + 18, 0); // d_type (DT_UNKNOWN, XXX)
		proc.copyToUser(dirp + 19, name, true);
		dirp = dirp + neededSize;
	}

	// FIXME: return #bytes, or 0 on EOF
	return ret;
}

function sys_fcntl64(proc) {
	// FIXME
	return -1;
}

function sys_fchmod(proc) {
	// FIXME
	return 0;
}

function sys_fchown(proc) {
	// FIXME
	return 0;
}

function sys_waitpid(proc) {
	var pid = proc.registers[4] >> 0;
	var status = proc.registers[5];
	var options = proc.registers[6];

	var foundChild = false;
	var proclist = [];
	if (pid == -1)
 		proclist = processes;
	else {
		if (processes[pid])
			proclist.push(processes[pid]);
	}

	// FIXME
	for (var n = processes.length-1; n > 0; --n) {
		var p = processes[n];
		if (p.ppid != proc.pid)
			continue;
		if (p.ppid == proc.pid && p.exited && p.exitCode != 'x') { // XXX
			var statusvar = 0; // TODO: terminating signal?
			statusvar |= ((p.exitCode & 0xff) << 8);
			proc.write32(status, statusvar);
			p.exitCode = 'x'; // XXX hack :(
			return p.pid;
		}

		if ((options & WNOHANG) != WNOHANG)
			p.exitCallbacks.push(function() { proc.running = true; wakeup(); });
		foundChild = true;
	}
	if (!foundChild)
		return -ECHILD;
	if ((options & WNOHANG) != WNOHANG)
		proc.running = false;

	return 0; // either we're blocking, or we got WNOHANG with children
}

function sys_exit(proc) {
	// exit() for a single thread.
	proc.exitCode = proc.registers[4];
	proc.exited = true;
	proc.running = false;
	return 0; // Doesn't matter.
}

function sys_exit_group(proc) {
	// exit() for the whole process.
	proc.exitCode = proc.registers[4];
	proc.exited = true;
	proc.running = false;
	return 0; // Doesn't matter.
}

function sys_kill(proc) {
	// FIXME
	var pid = proc.registers[4];
	var sig = proc.registers[5];
	return 0;
}

function sys_tgkill(proc) {
	// FIXME
	return 0;
}

function sys_nanosleep(proc) {
	// FIXME
	return 0;
}

function sys_alarm(proc) {
	// FIXME
	return 0;
}

function sys_getrlimit(proc) {
	var resource = proc.registers[4];
	var rlim = proc.registers[5];
	// FIXME
	return 0;
}

function sys_getrusage(proc) {
	var who = proc.registers[4];
	var usage = proc.registers[5];
	// FIXME
	return 0;
}

function sys_prlimit64(proc) {
	var pid = proc.registers[4];
	var resource = proc.registers[5];
	var new_limit = proc.registers[6];
	var old_limit = proc.registers[7];

	//console.log("prlimit64: " + resource);
	// FIXME
	return -1;
}

function sys_gettimeofday(proc) {
	// TODO
	var tv = proc.registers[4];
	var tz = proc.registers[5];
	var d = new Date();
	// seconds
	proc.write32(tv, d.getTime() / 1000.0);
	// milliseconds
	proc.write32(tv + 4, 1000 * (d.getTime() % 1000));
	// FIXME
	return 0;
}

function sys_access(proc) {
	var filename = proc.stringFromUser(proc.registers[4]);
	var mode = proc.registers[5];
	var node = getNodeForPath(filename, proc);
	if (typeof node == 'number')
		return node;
	// FIXME: check mode, etc
	return 0;
}

function sys_writev(proc) {
	// FIXME
	var fd = proc.registers[4];
	var iov = proc.registers[5];
	var iovcnt = proc.registers[6];
	var count = 0;
	for (var c = 0; c < iovcnt; ++c) {
		var addr = proc.read32(iov + 8*c);
		var length = proc.read32(iov + 8*c + 4);
		var str = "";
		for (var n = 0; n < length; ++n) {
			str += String.fromCharCode(proc.mem8[proc.translate(addr + n)]);
			count++;
		}
		process.stdout.write(str);
	}
	return count;
}

function sys_newuname(proc) {
	var addr = proc.registers[4];
	proc.copyToUser(addr + 0, "Linux", true); // sysname
	// TODO: custom nodename
	proc.copyToUser(addr + 65*1, "stroop", true); // nodename
	// We claim to be 3.2 because that's what my binaries are built against.
	// (this is checked by _dl_discover_osversion)
	proc.copyToUser(addr + 65*2, "3.2.0-noopsys", true); // release
	proc.copyToUser(addr + 65*3, "#1 3.2.0", true); // version
	proc.copyToUser(addr + 65*4, "mipsel", true); // machine
	proc.copyToUser(addr + 65*5, "", true); // domainname
	return 0;
}

function sys_getpeername(proc) {
	var sockfd = proc.registers[4];
	var addr = proc.registers[5];
	var addrlen = proc.registers[6];

	// XXX FIXME :)
	var length = proc.read32(addrlen);
	proc.copyToUser(addr, "stroop", false); // TODO: not null-terminated?
	proc.write32(addrlen, 6);

	return 0;
}

function sys_rt_sigaction(proc) {
	/*console.log("rt_sigaction " + proc.registers[4].toString(16));
	console.log("rt_sigaction " + proc.registers[5].toString(16));
	console.log("rt_sigaction " + proc.registers[6].toString(16));*/
	// FIXME
	return 0;
}

function sys_rt_sigprocmask(proc) {
	// FIXME
	return 0;
}

function sys_time(proc) {
	// FIXME
	return 0;
}

function sys_socket(proc) {
	// FIXME
	return -1;
}

function sys_connect(proc) {
	// FIXME
	return -1;
}

function sys_clone(proc) {
	// FIXME
	var flags = proc.registers[4];
	//console.log(flags.toString(16));
	var child_stack = proc.registers[5];
	var ptid = proc.registers[6];
	var ctid = proc.read32(proc.registers[29] + 16);
	var regs = proc.registers[7];

	var newProcess = new Process();
	newProcess.ppid = proc.pid;
	processes.push(newProcess);
	newProcess.pid = processes.length + 1;
	newProcess.cloneFrom(proc);

	if (flags & CLONE_CHILD_CLEARTID) {
		// FIXME: wha
	}
	if (flags & CLONE_CHILD_SETTID) {
		// FIXME
		newProcess.write32(ctid, newProcess.pid);
	}

	// Return 0 to the clone and the clone's pid to the parent.
	newProcess.registers[2] = 0;
	newProcess.registers[7] = 0;
	return newProcess.pid;
}

function sys_execve(proc) {
	var filenamep = proc.registers[4];
	filename = proc.stringFromUser(filenamep);
	if (filename === "/proc/self/exe") // XXX: horrible horrible FIXME XXX
		filename = "/bin/busybox";
	var argv = proc.registers[5];
	var envp = proc.registers[6];

	var node = getNodeForPath(filename, proc);
	// TODO: manpage says errors are a bit different
	if (typeof node == 'number')
		return node;

	var argv_copy = [];
	while (proc.read32(argv) != 0) {
		var arg = proc.stringFromUser(proc.read32(argv));
		argv_copy.push(arg);
		argv += 4;
	}
	var envp_copy = [];
	while (proc.read32(envp) != 0) {
		var arg = proc.stringFromUser(proc.read32(envp));
		envp_copy.push(arg);
		envp += 4;
	}

	// TODO: reset signals
	// TODO: close close-on-exec fds
	// TODO: other stuff
	proc.initMemory();

	// FIXME
	var buffer = node.data; // XXX: memfs only
	proc.loadElf(buffer, argv_copy, envp_copy);

	// Return value is irrelevant.
	return 0;
}

var syscalls = {
// 4000: sys_syscall,
4001: sys_exit,
// 4002: sys_fork,
4003: sys_read,
4004: sys_write,
4005: sys_open,
4006: sys_close,
4007: sys_waitpid,
// 4008: sys_creat,
// 4009: sys_link,
4010: sys_unlink,
4011: sys_execve,
4012: sys_chdir,
4013: sys_time,
// 4014: sys_mknod,
// 4015: sys_chmod,
// 4016: sys_lchown,
// 4017: sys_break, /* not implemented */
// 4018: sys_unused18, /* was sys_stat */
4019: sys_lseek,
4020: sys_getpid,
// 4021: sys_mount,
// 4022: sys_umount, /* oldumount */
4023: sys_setuid,
4024: sys_getuid,
// 4025: sys_stime,
// 4026: sys_ptrace,
4027: sys_alarm,
// 4028: sys_unused28, /* was sys_fstat */
// 4029: sys_pause,
// 4030: sys_utime,
// 4031: sys_stty, /* not implemented */
// 4032: sys_gtty, /* not implemented */
4033: sys_access,
// 4034: sys_nice,
// 4035: sys_ftime, /* not implemented */
// 4036: sys_sync,
4037: sys_kill,
// 4038: sys_rename,
// 4039: sys_mkdir,
// 4040: sys_rmdir,
4041: sys_dup,
4042: sys_pipe, /* weird ABI */
// 4043: sys_times,
// 4044: sys_prof, /* not implemented */
4045: sys_brk,
4046: sys_setgid,
4047: sys_getgid,
// 4048: sys_signal, /* not implemented */
4049: sys_geteuid,
4050: sys_getegid,
// 4051: sys_acct,
// 4052: sys_umount2,
// 4053: sys_lock, /* not implemented */
4054: sys_ioctl,
// 4055: sys_fcntl,
// 4056: sys_mpx, /* not implemented */
4057: sys_setpgid,
// 4058: sys_ulimit, /* not implemented */
// 4059: sys_olduname,
// 4060: sys_umask,
// 4061: sys_chroot,
// 4062: sys_ustat,
4063: sys_dup2,
4064: sys_getppid,
4065: sys_getpgrp,
// 4066: sys_setsid,
// 4067: sys_sigaction,
// 4068: sys_sgetmask,
// 4069: sys_ssetmask,
// 4070: sys_setreuid,
// 4071: sys_setregid,
// 4072: sys_sigsuspend,
// 4073: sys_sigpending,
// 4074: sys_sethostname,
// 4075: sys_setrlimit,
4076: sys_getrlimit,
4077: sys_getrusage,
4078: sys_gettimeofday,
// 4079: sys_settimeofday,
4080: sys_getgroups,
4081: sys_setgroups,
// 4082: sys_reserved82, /* not implemented, old_select */
// 4083: sys_symlink,
// 4084: sys_unused84, /* was sys_lstat */
4085: sys_readlink,
// 4086: sys_uselib,
// 4087: sys_swapon,
// 4088: sys_reboot,
// 4089: sys_readdir, /* sys_old_readdir */
4090: sys_mmap, /* mips_mmap */
4091: sys_munmap,
// 4092: sys_truncate,
// 4093: sys_ftruncate,
4094: sys_fchmod,
4095: sys_fchown,
// 4096: sys_getpriority,
// 4097: sys_setpriority,
// 4098: sys_profil, /* not implemented */
// 4099: sys_statfs,
// 4100: sys_fstatfs,
// 4101: sys_ioperm, /* not implemented */
// 4102: sys_socketcall,
// 4103: sys_syslog,
// 4104: sys_setitimer,
// 4105: sys_getitimer,
// 4106: sys_stat, /* sys_newstat */
// 4107: sys_lstat, /* sys_newlstat */
// 4108: sys_fstat, /* sys_newfstat */
// 4109: sys_uname,
// 4110: sys_iopl, /* not implemented */
// 4111: sys_vhangup,
// 4112: sys_idle, /* not implemented */
// 4113: sys_vm86, /* not implemented */
// 4114: sys_wait4,
// 4115: sys_swapoff,
// 4116: sys_sysinfo,
// 4117: sys_ipc,
// 4118: sys_fsync,
// 4119: sys_sigreturn,
4120: sys_clone,
// 4121: sys_setdomainname,
4122: sys_newuname,
// 4123: sys_modify_ldt, /* not implemented */
// 4124: sys_adjtimex,
4125: sys_mprotect,
// 4126: sys_sigprocmask,
// 4127: sys_create_module, /* not implemented */
// 4128: sys_init_module,
// 4129: sys_delete_module,
// 4130: sys_get_kernel_syms, /* not implemented */
// 4131: sys_quotactl,
// 4132: sys_getpgid,
// 4133: sys_fchdir,
// 4134: sys_bdflush,
// 4135: sys_sysfs,
// 4136: sys_personality, /* not implemented, for afs_syscall */
// 4137: sys_afs_syscall,
// 4138: sys_setfsuid,
// 4139: sys_setfsgid,
4140: sys__llseek,
// 4141: sys_getdents,
// 4142: sys__newselect,
// 4143: sys_flock,
// 4144: sys_msync,
// 4145: sys_readv,
4146: sys_writev,
// 4147: sys_cacheflush,
// 4148: sys_cachectl,
// 4149: sys_sysmips,
// 4150: sys_unused150,
// 4151: sys_getsid,
// 4152: sys_fdatasync,
// 4153: sys__sysctl,
// 4154: sys_mlock,
// 4155: sys_munlock,
// 4156: sys_mlockall,
// 4157: sys_munlockall,
// 4158: sys_sched_setparam,
// 4159: sys_sched_getparam,
// 4160: sys_sched_setscheduler,
// 4161: sys_sched_getscheduler,
// 4162: sys_sched_yield,
// 4163: sys_sched_get_priority_max,
// 4164: sys_sched_get_priority_min,
// 4165: sys_sched_rr_get_interval,
4166: sys_nanosleep,
// 4167: sys_mremap,
// 4168: sys_accept,
// 4169: sys_bind,
// 4170: sys_connect,
4171: sys_getpeername,
// 4172: sys_getsockname,
// 4173: sys_getsockopt,
// 4174: sys_listen,
// 4175: sys_recv,
// 4176: sys_recvfrom,
// 4177: sys_recvmsg,
// 4178: sys_send,
// 4179: sys_sendmsg,
// 4180: sys_sendto,
// 4181: sys_setsockopt,
// 4182: sys_shutdown,
4183: sys_socket,
// 4184: sys_socketpair,
// 4185: sys_setresuid,
// 4186: sys_getresuid,
// 4187: sys_query_module, /* not implemented */
4188: sys_poll,
// 4189: sys_nfsservctl, /* not implemented */
// 4190: sys_setresgid,
// 4191: sys_getresgid,
// 4192: sys_prctl,
// 4193: sys_rt_sigreturn,
4194: sys_rt_sigaction,
4195: sys_rt_sigprocmask,
// 4196: sys_rt_sigpending,
// 4197: sys_rt_sigtimedwait,
// 4198: sys_rt_sigqueueinfo,
// 4199: sys_rt_sigsuspend,
// 4200: sys_pread64,
// 4201: sys_pwrite64,
// 4202: sys_chown,
4203: sys_getcwd,
// 4204: sys_capget,
// 4205: sys_capset,
// 4206: sys_sigaltstack,
// 4207: sys_sendfile,
// 4208: sys_getpmsg,
// 4209: sys_putpmsg,
4210: sys_mmap2, /* sys_mips_mmap2 */
// 4211: sys_truncate64,
// 4212: sys_ftruncate64,
4213: sys_stat64,
4214: sys_lstat64,
4215: sys_fstat64,
// 4216: sys_pivot_root,
// 4217: sys_mincore,
4218: sys_madvise,
4219: sys_getdents64,
4220: sys_fcntl64,
// 4221: sys_reserved221,
// 4222: sys_gettid,
// 4223: sys_readahead,
// 4224: sys_setxattr,
// 4225: sys_lsetxattr,
// 4226: sys_fsetxattr,
// 4227: sys_getxattr,
// 4228: sys_lgetxattr,
// 4229: sys_fgetxattr,
// 4230: sys_listxattr,
// 4231: sys_llistxattr,
// 4232: sys_flistxattr,
// 4233: sys_removexattr,
// 4234: sys_lremovexattr,
// 4235: sys_fremovexattr,
// 4236: sys_tkill,
// 4237: sys_sendfile64,
// 4238: sys_futex,
// 4239: sys_sched_setaffinity,
// 4240: sys_sched_getaffinity,
// 4241: sys_io_setup,
// 4242: sys_io_destroy,
// 4243: sys_io_getevents,
// 4244: sys_io_submit,
// 4245: sys_io_cancel,
4246: sys_exit_group,
// 4247: sys_lookup_dcookie,
// 4248: sys_epoll_create,
// 4249: sys_epoll_ctl,
// 4250: sys_epoll_wait,
// 4251: sys_remap_file_pages,
// 4252: sys_set_tid_address,
// 4253: sys_restart_syscall,
// 4254: sys_fadvise64,
// 4255: sys_statfs64,
// 4256: sys_fstatfs64,
// 4257: sys_timer_create,
// 4258: sys_timer_settime,
// 4259: sys_timer_gettime,
// 4260: sys_timer_getoverrun,
// 4261: sys_timer_delete,
// 4262: sys_clock_settime,
// 4263: sys_clock_gettime,
// 4264: sys_clock_getres,
// 4265: sys_clock_nanosleep,
4266: sys_tgkill,
// 4267: sys_utimes,
// 4268: sys_mbind,
// 4269: sys_get_mempolicy,
// 4270: sys_set_mempolicy,
// 4271: sys_mq_open,
// 4272: sys_mq_unlink,
// 4273: sys_mq_timedsend,
// 4274: sys_mq_timedreceive,
// 4275: sys_mq_notify,
// 4276: sys_mq_getsetattr,
// 4277: sys_vserver, /* not implemented */
// 4278: sys_waitid,
// 4279: sys_sys_setaltroot, /* not implemented */
// 4280: sys_add_key,
// 4281: sys_request_key,
// 4282: sys_keyctl,
4283: sys_set_thread_area,
// 4284: sys_inotify_init,
// 4285: sys_inotify_add_watch,
// 4286: sys_inotify_rm_watch,
// 4287: sys_migrate_pages,
4288: sys_openat,
// 4289: sys_mkdirat,
// 4290: sys_mknodat,
// 4291: sys_fchownat,
// 4292: sys_futimesat,
// 4293: sys_fstatat64,
// 4294: sys_unlinkat,
// 4295: sys_renameat,
// 4296: sys_linkat,
// 4297: sys_symlinkat,
// 4298: sys_readlinkat,
// 4299: sys_fchmodat,
// 4300: sys_faccessat,
// 4301: sys_pselect6,
// 4302: sys_ppoll,
// 4303: sys_unshare,
// 4304: sys_splice,
// 4305: sys_sync_file_range,
// 4306: sys_tee,
// 4307: sys_vmsplice,
// 4308: sys_move_pages,
// 4309: sys_set_robust_list,
// 4310: sys_get_robust_list,
// 4311: sys_kexec_load,
// 4312: sys_getcpu,
// 4313: sys_epoll_pwait,
// 4314: sys_ioprio_set,
// 4315: sys_ioprio_get,
// 4316: sys_utimensat,
// 4317: sys_signalfd,
// 4318: sys_timerfd, /* not implemented */
// 4319: sys_eventfd,
// 4320: sys_fallocate,
// 4321: sys_timerfd_create,
// 4322: sys_timerfd_gettime,
// 4323: sys_timerfd_settime,
// 4324: sys_signalfd4,
// 4325: sys_eventfd2,
// 4326: sys_epoll_create1,
// 4327: sys_dup3,
// 4328: sys_pipe2,
// 4329: sys_inotify_init1,
// 4330: sys_preadv,
// 4331: sys_pwritev,
// 4332: sys_rt_tgsigqueueinfo,
// 4333: sys_perf_event_open,
// 4334: sys_accept4,
// 4335: sys_recvmmsg,
// 4336: sys_fanotify_init,
// 4337: sys_fanotify_mark,
4338: sys_prlimit64,
// 4339: sys_name_to_handle_at,
// 4340: sys_open_by_handle_at,
// 4341: sys_clock_adjtime,
// 4342: sys_syncfs,
// 4343: sys_sendmmsg,
// 4344: sys_setns,
// 4345: sys_process_vm_readv,
// 4346: sys_process_vm_writev,
// 4347: sys_kcmp,
// 4348: sys_finit_module,
// 4349: sys_sched_setattr,
// 4350: sys_sched_getattr,
// 4351: sys_renameat2,
// 4352: sys_seccomp,
// 4353: sys_getrandom,
// 4354: sys_memfd_create,
// 4355: sys_bpf,
// 4356: sys_execveat,
// 4357: sys_userfaultfd,
// 4358: sys_membarrier,
// 4359: sys_mlock2
};