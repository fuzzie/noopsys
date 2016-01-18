// In the world of noop, everything is a pseudoterminal (using N_TTY).
// So generally we do what Linux's pty(/tty) layer does.
function TTY(reads, writes) {
	this.readStream = reads;
	this.writeStream = writes;

	// TODO: if we implement multiple TTYs we might need to remove this?
	var tthis = this;
	// FIXME: broken for non-nodejs-hack cases
	this.readStream.readStream.on('readable', function() { tthis.update(); });

	this.session = 0;
	this.pgrp = 0;

	// termios
	this.c_iflag = ICRNL | IXON;
	this.c_oflag = OPOST | ONLCR;
	this.c_cflag = B38400 | CS8 | CREAD | HUPCL;
	this.c_lflag = ISIG | ICANON | ECHO | ECHOE | ECHOK | ECHOCTL | ECHOKE | IEXTEN;
	this.c_line = 0; // N_TTY
	// FIXME: this is in kernel format but we should use userspace format directly??
	//this.c_cc = [3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, /**/ 0,0,0,0,0,0];
	this.c_cc = [3, 28, 127, 21, 1, 0, 0, 0, 17, 19, 26, 0, 18, 15, 23, 22, 4, /**/ 0,0,0,0,0,0];
	this.c_ispeed = 38400;
	this.c_ospeed = 38400;

	// read_head points to the index of read_buf which we'll write to next
	// canon_head points to the index of read_buf which we will write to (always >= read_tail)
	// echo_head points to ??
	// echo_commit points to ??
	// echo_mark points to ??

	this.data = []; // aka read_buf
	// this.echo_buf = "";

	// read_tail points to the index of read_buf which has been read
	// line_start points to ??

	this.column = 0;
	this.canon_column = 0;
	// echo_tail points to ??

	this.stopped = false; // XXX: ???
	this.flow_stopped = false;

	this.set_termios();
}

TTY.prototype.close = function() {
	// TODO
}

TTY.prototype.clone = function() {
	return this; // TODO
}

TTY.prototype.set_termios = function() {
	this.cflag &= ~(CSIZE | PARENB);
	this.cflag |= (CS8 | CREAD);

	// FIXME: handle flipped flags (see n_tty_set_termios)
}

TTY.prototype.is_continuation = function(c) {
	if (!(this.c_iflag & IUTF8))
		return false;
	return (c & 0xc0) == 0x80;
}

TTY.prototype.queue = function(c) {
	this.data.push(c);
}

TTY.prototype.update = function() {
	this.readStream.read(null, 1);
	for (var n = 0; n < this.readStream.data.length; ++n) {
		this.receive_char(this.readStream.data[n]);
	}
	this.readStream.data = this.readStream.data.slice(0, 0);
}

TTY.prototype.read = function(process, size) {
	// FIXME: This is wrong.
	if (this.data.length)
		return this.data.length;

	// FIXME: This is wrong too.
	var ret = this.readStream.read(process, 1);
	if (ret == -EAGAIN)
		return ret;

	this.update();

	// FIXME: Also :)
	if (this.data.length > size)
		return size;
	return this.data.length;
}

TTY.prototype.write = function(process, data) {
	// TODO: We probably should have a limit on the amount we queue, somewhere.
	if (this.c_oflag & OPOST) {
		for (var n = 0; n < data.length; ++n) {
			this.do_output_char(data.charCodeAt(n));
		}
	} else
		this.writeStream.write(process, data);
	return data.length;
}

// Pretty much straight from n_tty.c.
// TODO: do something similar to the process_output_block optimisation?
TTY.prototype.do_output_char = function(c) {
	switch (c) {
	case 0xa: // \n
		if (this.c_oflag & ONLRET)
			this.column = 0;
		if (this.c_oflag & ONLCR) {
			this.canon_column = 0;
			this.column = 0;
			this.writeStream.write(null, "\r\n");
			return;
		}
		this.canon_column = this.column;
		break;
	case 0xd: // \r
		if ((this.c_oflag & ONOCR) && this.column == 0)
			return;
		if (this.c_oflag & OCRNL) {
			c = 0xa; // \n
			if (!(this.c_oflag & ONLRET))
				break;
		}
		this.canon_column = 0;
		this.column = 0;
		break;
	case 0x9: // \t
		var spaces = 8 - (this.column & 7);
		if ((this.c_oflag & TABDLY) == XTABS) {
			this.column += spaces;
			this.writeStream.write(null, "        ".slice(0, spaces));
			return;
		}
		this.column += spaces;
		break;
	case 0x8: // \b
		if (this.column > 0)
			this.column--;
		break;
	default:
		if (c >= 32) { // iscntrl
			/*if (this.c_oflag & OLCUC)
				c = toupper(c);*/
			if (!this.is_continuation(c))
				this.column++;
		}
		break;
	}

	// XXX: the null should be current process, but sigh (see also above)
	this.writeStream.write(null, String.fromCharCode(c));
}

TTY.prototype.receive_char = function(c) {
	if (this.c_iflag & ISTRIP)
		c &= 0x7f;
	/*if ((this.c_iflag & IUCLC) && (this.c_lflag & IEXTEN))
		c = tolower(c);*/
	if (this.c_lflag & EXTPROC) {
		this.queue(c)
		return;
	}
	this.receive_char_special(c);
}

TTY.prototype.isig = function(signo) {
	// FIXME: send to whole pgrp
	// FIXME: sanity check
	processes[this.pgrp-1].sendSignal(signo, null);
}

// Pretty much straight from n_tty.c.
TTY.prototype.receive_char_special = function(c) {
	if (this.c_iflag & IXON) {
		if (c == this.c_cc[VSTART]) {
			console.log("TODO: flow start"); // TODO (start)
			return;
		} else if (c == this.c_cc[VSTOP]) {
			console.log("TODO: flow stop"); // TODO (stop)
			return;
		}
	}

	if (this.c_lflag & ISIG) {
		if (c == this.c_cc[VINTR]) {
			this.isig(SIGINT);
			return;
		} else if (c == this.c_cc[VQUIT]) {
			this.isig(SIGQUIT);
			return;
		} else if (c == this.c_cc[VSUSP]) {
			this.isig(SIGTSTP);
			return;
		}
	}

	if (this.stopped && !this.flow_stopped && (this.c_iflag & IXON) && (this.c_iflag & IXANY)) {
		console.log("TODO: flow start"); // TODO (start)
	}

	if (c == 0xd) { // \r
		if (this.c_iflag & IGNCR)
			return;
		if (this.c_iflag & ICRNL)
			c = 0xa; // \n
	} else if (c == 0xa && (this.c_iflag & INLCR)) // \n
		c = 0xd; // \r

	// if (this.icanon) { // FIXME
	if (this.c_iflag & ICANON) {
		// FIXME
	}

	if (this.c_lflag & ECHO) {
		// FIXME
		this.writeStream.write(null, String.fromCharCode(c)); // FIXME :p
	}

	// FIXME: "PARMRK doubling check" (0xff)

	this.queue(c);
}
