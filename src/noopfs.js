
var S_ISLNK = function(m) { return (m & S_IFLNK) == S_IFLNK; }
var S_ISREG = function(m) { return (m & S_IFREG) == S_IFREG; }
var S_ISDIR = function(m) { return (m & S_IFDIR) == S_IFDIR; }

function TTY() {
}

TTY.prototype.ioctl = function(nr, type, size, dir, addr) {
};

// XXX: ugh, rethink this design
function PipeWriter() {
	this.readCallbacks = [];
	this.refs = 1; // XXX: also this
}

PipeWriter.prototype.write = function(process, data) {
	// FIXME: buffer?
	this.src.data = this.src.data.concat(data); // XXX: design rethink

	for (var n = 0; n < this.readCallbacks.length; ++n)
		this.readCallbacks[n]();
	this.readCallbacks = [];

	return data.length;
}

PipeWriter.prototype.close = function() {
	if (this.refs == 0)
		throw Error("closing pipe which is already dead");

	this.refs--;
	//console.log("pipe now " + this.refs + " refs");

	if (this.refs == 0) {
		for (var n = 0; n < this.readCallbacks.length; ++n)
			this.readCallbacks[n]();
		this.readCallbacks = [];
	}
}

PipeWriter.prototype.clone = function() {
	// hack :(
	this.refs++;
	return this;
}

function PipeReader(src) {
	this.src = src;
	this.data = ""; // XXX: design rethink
}

PipeReader.prototype.read = function(process, size) {
	// If we already buffered enough data, return it.
	if (this.data.length >= size)
		return size;

	// If the other end of the pipe has been closed, there's no more data.
	if (this.src.refs == 0)
		return this.data.length;

	// Resume the process once data is available.
	this.src.readCallbacks.push(function() {
		process.running = true;
		wakeup();
	});

	// Block until then.
	process.running = false;
	return -EAGAIN;
}

PipeReader.prototype.clone = function() {
	// XXX
	return this;
}

PipeReader.prototype.close = function() {
}

if (typeof window == 'undefined') {

/* for node.js use,  */
function StreamBackedFile(read, write) {
	this.readStream = read;
	this.writeStream = write;

	this.data = new Buffer(0);

	// XXX: The rest of this is a hack because node doesn't seem to let me
	// distinguish between EOF and no data being available.
	this.ended = false;

	var tthis = this;
	if (this.readStream) {
		// FIXME: we leak this when the file is closed
		this.readStream.once('end', function() {
			tthis.ended = true;
			tthis.readStream.emit('readable');
		});
	}
}

StreamBackedFile.prototype.read = function(process, size) {
	if (this.readStream === null)
		return -EBADF;

	// If we already buffered enough data, return it.
	if (this.data.length >= size)
		return size;

	// Read all data available (we could avoid buffering here, but meh).
	var data = this.readStream.read(size);
	if (data) {
		this.data = Buffer.concat([this.data, data])
		if (this.data.length >= size)
			return size;
	}

	// We couldn't fill the buffer; did we reach the end?
	if (this.ended)
		return this.data.length;

	// Resume the process once data is available.
	var tthis = this;
	this.readStream.once('readable', function() {
		process.running = true;
		wakeup();
	});

	// Block until then.
	process.running = false;
	return -EAGAIN;
} 

StreamBackedFile.prototype.write = function(process, data) {
	if (this.writeStream === null)
		return -EBADF;

	this.writeStream.write(data);

	return data.length;
}

StreamBackedFile.prototype.clone = function() {
	return this; // XXX
}

StreamBackedFile.prototype.close = function() {
}

} else {
	// browser

	var terminalObj;
	function TerminalBackedFile(term) {
		this.term = term;
		this.data = [];

		var tthis = this;
		this.term.on('data', function(chunk) {
			for (var i = 0; i < chunk.length; i++)
				tthis.data.push(chunk[i].charCodeAt(0));
		});
	}

	TerminalBackedFile.prototype.read = function(process, size) {
		// If we already buffered enough data, return it.
		if (this.data.length >= size)
			return size;

		// Resume the process once data is available.
		this.term.once('data', function(chunk) {
			process.running = true;
			wakeup();
		});

		// Block until then.
		process.running = false;
		return -EAGAIN;
	}

	TerminalBackedFile.prototype.write = function(process, data) {
		this.term.write(data);
		return data.length;
	}

	TerminalBackedFile.prototype.clone = function() {
		return this; // XXX
	}

	TerminalBackedFile.prototype.close = function() {
	}
}

function memFSBackedFile(node) {
	this.node = node;
	this.pos = 0;
	this.data = []; // buffer
}

memFSBackedFile.prototype.read = function(process, size) {
	if (S_ISDIR(this.node.mode))
		return -EISDIR;

	// FIXME
	if (this.node.data === undefined)
		return -EIO;

	// XXX: this actually breaks for memfs
	try {
		this.data = new Uint8Array(this.node.data).slice(this.pos, this.pos + size);
	} catch (e) {
		this.data = this.node.data.slice(this.pos, this.pos + size);
	}
	var len = this.data.length;
	this.pos = this.pos + len;
	return len;
}

memFSBackedFile.prototype.clone = function() {
	// TODO: think about this

	var n = new memFSBackedFile(this.node);
	n.pos = this.pos;
	n.data = this.data.slice();
	return n;
}

memFSBackedFile.prototype.close = function() {
}

var globalInodeHack = 0;

function memFSNode(data, parent) {
	this.inode = ++globalInodeHack;
	this.mode = 0; // XXX: think
	this.size = 0; // XXX: think
	if (data) {
		this.mode = data.mode;
	}
	this.parent = parent;
	if (!parent) // must be root
		this.parent = this;
	this.children = {};
	if (S_ISDIR(this.mode)) { // XXX: think
		this.children['.'] = this;
		this.children['..'] = this.parent;
	}
}

memFSNode.prototype.getChildren = function() {
	return this.children;
}

memFSNode.prototype.populateFromData = function(data) {
	if (data.data) {
		// Lightweight embedding, especially for symlinks.
		this.data = data.data;
		this.size = this.data.length;
	}
	if (!data.contents)
		return;
	for (var n = 0; n < data.contents.length; ++n) {
		var entry = data.contents[n];
		var node = new memFSNode(entry, this);
		this.children[entry.name] = node;
		node.populateFromData(entry);
	}
}

function procFSRoot(parent) {
	this.parent = parent;
	this.inode = ++globalInodeHack;
}

procFSRoot.prototype.getChildren = function() {
	children = {};
	children['.'] = this;
	children['..'] = this.parent;

	// XXX: this is not nice (wastes inodes, wrong devnr, etc)
	children['self'] = new memFSNode({mode: 365 | S_IFLNK}, this);
	children['self'].data = currentProcessId.toString();

	for (var n = 0; n < processes.length; ++n) {
		if (!processes[n] || processes[n].exited)
			continue;
		children[(n+1).toString()] = new procFSProcess(this, n+1);
	}

	// FIXME

	return children;
}

function procFSProcess(parent, pid) {
	this.parent = parent;
	this.mode = 365 | S_IFDIR;
	// TODO: gid, uid
	this.pid = pid;
	this.inode = pid;
	this.inode = ++globalInodeHack; // XXX: nooo
}

procFSProcess.prototype.getChildren = function() {
	children = {};
	children['.'] = this;
	children['..'] = this.parent;

	// XXX: ugh
	children['cwd'] = new memFSNode({mode: 365 | S_IFLNK}, this);
	children['cwd'].data = processes[this.pid-1].cwd;
	children['root'] = new memFSNode({mode: 365 | S_IFLNK}, this);
	children['root'].data = "/"; // TODO

	// FIXME

	return children;
}

var fsData = {
	mode: 365 | S_IFDIR,
	contents: [
	{
	name: "bin",
	mode: 365 | S_IFDIR,
	contents: [
		{ name: "busybox", mode: 365 | S_IFREG, realPath: "data/busybox" },
		{ name: "sh", mode: 365 | S_IFLNK, data: "/bin/busybox" }
	]
	},
	{
	name: "etc",
	mode: 365 | S_IFDIR,
	contents: [
		{ name: "passwd", mode: 292 | S_IFREG, data: "root::0:0:root:/root:/bin/sh\n" },
		{ name: "group", mode: 292 | S_IFREG, data: "root:x:0:\n" }
	]
	}
]};

var fsRoot = new memFSNode(fsData, null);
fsRoot.parent = fsRoot;
fsRoot.populateFromData(fsData);

// XXX: think about mounting?
fsRoot.children['proc'] = new procFSRoot(fsRoot);
fsRoot.children['proc'].mode = 365 | S_IFDIR;

var getNodeForAbsPath = function(path, stopOnLinks) {
	var numLinks = 0; // XXX: think about stopOnLinks

	var comp = path.split("/");
	if (comp[0].length) throw Error();

	// TODO: everything link_path_walk does?
	var node = fsRoot;
	for (var n = 1; n < comp.length; ++n) {
		var name = comp[n];
		if (name === "") // '/'
			continue;
		// TODO: dehardcode?
		/*if (name === ".") {
			continue;
		} else if (name === "..") {
			node = node.parent;
			continue;
		}*/
		var children = node.getChildren();
		if (!(name in children))
			return -ENOENT;
		var newNode = children[name];
		if (S_ISLNK(newNode.mode)) {
			if (stopOnLinks && (n == comp.length-1))
				return newNode;

			// This is a bit less than the real kernel.
			// XXX: constant?
			if (numLinks++ > 10)
				return -ELOOP;

			// Splice the new path into our array.
			Array.prototype.splice.apply(comp, [n+1, 0].concat(newNode.data.split("/")));
			if (newNode.data[0] == "/") {
				// If it's an absolute path, lookups continue from the root.
				node = fsRoot;
			}
		} else {
			node = newNode;
		}
	}
	return node;
}

var getNodeForPath = function(path, proc, stopOnLinks) {
	if (!path.length)
		return -ENOENT;
	if (path[0] != '/')
		path = proc.cwd + '/' + path; // XXX
	return getNodeForAbsPath(path, stopOnLinks);
}

