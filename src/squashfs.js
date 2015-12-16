var SQUASHFS_MAGIC = 0x73717368;
var SQUASHFS_METADATA_SIZE = 8192;

var SQUASHFS_DIR_TYPE = 1;
var SQUASHFS_FILE_TYPE = 2;
var SQUASHFS_SYMLINK_TYPE = 3;
var SQUASHFS_LREG_TYPE = 9;

function SquashFSError(msg) {
	return Error("squashfs: " + msg);
}

function SquashFS_superblock(sfs) {
	var s_magic = sfs.read32();
	if (s_magic != SQUASHFS_MAGIC)
		throw SquashFSError("bad magic " + s_magic.toString(16));

	this.inodes = sfs.read32();
	this.mkfs_time = sfs.read32();
	this.block_size = sfs.read32();
	this.fragments = sfs.read32();
	this.compression = sfs.read16();
	this.block_log = sfs.read16();
	this.flags = sfs.read16();
	this.no_ids = sfs.read16();
	this.s_major = sfs.read16();
	this.s_minor = sfs.read16();
	this.root_inode = sfs.readInodeId();
	this.bytes_used = sfs.read64();
	this.id_table_start = sfs.read64();
	this.xattr_table_start = sfs.read64();
	this.inode_table_start = sfs.read64();
	this.directory_table_start = sfs.read64();
	this.fragment_table_start = sfs.read64();
	this.lookup_table_start = sfs.read64();

	this.directory_table_end = this.fragment_table_start; // XXX (only if no fragments)
	
	if (this.s_major != 4 || this.s_minor != 0)
		throw SquashFSError("unsupported version " + this.s_major + "." + this.s_minor);

	// TODO: check compression, compression flags

	// TODO: check flags
}

function SquashFS(inputdata) {
	this.data = inputdata;
	this.buffer = new Uint8Array(this.data);
	this.offset = 0;

	this.nextBlock = 0; // invalid

	this.sBlk = new SquashFS_superblock(this);

	var root_inode_start = this.sBlk.root_inode[0];
	var root_inode_offset = this.sBlk.root_inode[1];

	this.read_id_table();

	var ino = this.read_table(this.sBlk.inode_table_start, this.sBlk.directory_table_start);
	this.inode_table_buffer = ino[0];
	this.inode_table_hash = ino[1];
	var dir = this.read_table(this.sBlk.directory_table_start, this.sBlk.directory_table_end);
	this.directory_table_buffer = dir[0];
	this.directory_table_hash = dir[1];

	printk("squashfs: allocated " + this.inode_table_buffer.byteLength + " bytes for inodes and " + this.directory_table_buffer.byteLength + " bytes for directories\n");

	this.root = this.readInode(this.sBlk.root_inode);
	if (this.root.inode_type != SQUASHFS_DIR_TYPE && this.root.inode_type != SQUASHFS_LDIR_TYPE)
		throw SquashFSError("root inode isn't a directory");
	this.directory_start_block = this.root.start_block;

	this.root.children = this.root.readEntries();
	this.root.children['.'] = this.root;
	this.root.children['..'] = this.root;
}

function SquashFSInode(sfs) {
	this.sfs = sfs;

	this.mode = sfs.read16();
	this.uid = sfs.read16();
	this.gid = sfs.read16();
	this.mtime = sfs.read32();
	this.inode = sfs.read32();
}

function SquashFSSymlinkInode(sfs) {
	SquashFSInode.call(this, sfs);

	this.mode |= S_IFLNK;
	this.inode_type = SQUASHFS_DIR_TYPE;

	this.nlink = sfs.read32();
	var size = sfs.read32(); // XXX: correct?
	this.data = sfs.readString(size);
}

function SquashFSFileInode(sfs) {
	SquashFSInode.call(this, sfs);

	this.mode |= S_IFREG;
	this.inode_type = SQUASHFS_FILE_TYPE;

	this.start_block = sfs.read32();
	this.fragment = sfs.read32();
	this.offset = sfs.read32();
	this.size = sfs.read32();

	// TODO: merge with lreg?
	this.blockList = [];
	// TODO: fragments?
	var count = (this.size + this.sfs.sBlk.block_size - 1) >>> this.sfs.sBlk.block_log;
	for (var n = 0; n < count; ++n)
		this.blockList.push(sfs.read32());

	// XXX hackery, shouldn't be reading everything at startup
	this.data = new ArrayBuffer(this.size);
	var data = new Uint8Array(this.data);
	var dataSoFar = 0;
	this.sfs.buffer = new Uint8Array(this.sfs.data);
	this.sfs.offset = this.start_block;
	for (var n = 0; n < this.blockList.length; ++n) {
		var size = this.sfs.sBlk.block_size;
		var remaining = this.size - dataSoFar;
		if (size > remaining)
			size = remaining;

		var block = this.blockList[n];

		if (block) {
			var blockSize = block & 0xffffff;
			var isCompressed = !(block & 0x1000000);
			if (isCompressed)
				throw SquashFSError("compression not yet supported");
			for (var i = 0; i < size; ++i)
				data[dataSoFar++] = this.sfs.buffer[this.sfs.offset++];
		} else {
			for (var i = 0; i < size; ++i)
				data[dataSoFar++] = 0;
		}
	}
}

function SquashFSLRegInode(sfs) {
	SquashFSInode.call(this, sfs);

	this.mode |= S_IFREG;
	this.inode_type = SQUASHFS_LREG_TYPE;

	this.start_block = sfs.read32();
	this.size = sfs.read32();
	this.sparse = sfs.read32();
	this.nlink = sfs.read32();
	this.fragment = sfs.read32();
	this.offset = sfs.read32();
	this.xattr = sfs.read32();

	this.blockList = [];
	var count = (this.size + this.sfs.sBlk.block_size - 1) >> this.sfs.sBlk.block_log;
	for (var n = 0; n < count; ++n)
		this.blockList.push(sfs.read32());
}

function SquashFSDirInode(sfs) {
	SquashFSInode.call(this, sfs);

	this.mode |= S_IFDIR;
	this.inode_type = SQUASHFS_DIR_TYPE;

	this.start_block = sfs.read32();
	this.nlink = sfs.read32();
	this.size = sfs.read16();
	this.offset = sfs.read16();
	this.parent_inode = sfs.read32();
}

SquashFSDirInode.prototype.getChildren = function() {
	if (this.children !== undefined)
		return this.children;

	this.children = this.readEntries();
	this.children['.'] = this;
	this.children['..'] = this.parent;
	return this.children;
}

SquashFSDirInode.prototype.readEntries = function() {
	var files = {};

	if (this.size < 3)
		throw SquashFSError("only " + this.size + " files in directory");

	// If there are no entries, don't try (and fail) to find a block.
	// (Our caller is responsible for adding the '.' and '..' entries.)
	if (this.size == 3)
		return files;

	var block = this.sfs.sBlk.directory_table_start + this.start_block;
	this.sfs.buffer = new Uint8Array(this.sfs.directory_table_buffer);
	this.sfs.offset = this.sfs.directory_table_hash[block];
	if (this.sfs.offset === undefined)
		throw SquashFSError("couldn't find block " + block + " in directory table hash");
 	this.sfs.offset += this.offset;

	var bytes = 0;
	while (bytes < this.size - 3) {
		var count = this.sfs.read32() + 1;
		var start_block = this.sfs.read32();
		var inode_number_2 = this.sfs.read32();
//		if (this.inode != inode_number_2)
//			throw SquashFSError("directory " + this.inode + " read block for " + inode_number_2);
		bytes += 12;

		for (var n = 0; n < count; ++n) {
			var offset = this.sfs.read16();
			var inode_number = this.sfs.read16();
			var type = this.sfs.read16();
			var size = this.sfs.read16();
			bytes += 8;

			var filename = this.sfs.readString(size+1);

			// The above is enough information for getdents, but
			// we retrieve the whole inode now.
			var oldbuffer = this.sfs.buffer;
			var oldoffset = this.sfs.offset;
			// FIXME: hardlinks
			files[filename] = this.sfs.readInode([start_block, offset]);
			files[filename].parent = this;
			this.sfs.buffer = oldbuffer;
			this.sfs.offset = oldoffset;

			bytes += size + 1;
		}
	}

	return files;
}

SquashFS.prototype.readInode = function(inode) {
	this.buffer = new Uint8Array(this.inode_table_buffer);

	var block = this.sBlk.inode_table_start + inode[0];
	this.offset = this.inode_table_hash[block];
	if (this.offset === undefined)
		throw SquashFSError("couldn't find block " + block + " in inode table hash");
	this.offset += inode[1];

	var inode_type = this.read16();

	switch (inode_type) {
	case SQUASHFS_DIR_TYPE:
		return new SquashFSDirInode(this);
	case SQUASHFS_FILE_TYPE:
		return new SquashFSFileInode(this);
	case SQUASHFS_SYMLINK_TYPE:
		return new SquashFSSymlinkInode(this);
	case SQUASHFS_LREG_TYPE:
		return new SquashFSLRegInode(this);
	default:
		throw SquashFSError("unsupported inode type " + inode_type);
	}
}

SquashFS.prototype.useBlock = function(offset, expected) {
	this.buffer = new Uint8Array(this.data);

	this.offset = offset;
	var c_byte = this.read16();
	var compressed = (c_byte & 0x8000) != 0x8000;
	c_byte = c_byte & 0x7fff; // on-disk size

	if (compressed)
		throw SquashFSError("compression not yet supported");
	if (expected && c_byte != expected)
		throw SquashFSError("expected " + expected + " but block was of size " + c_byte);

	this.buffer = new Uint8Array(this.data, this.offset, c_byte);
	this.offset = 0;

	this.nextBlock = offset + 2 + c_byte;
}

SquashFS.prototype.read_table = function(start, end) {
	// For simplicity, we just read entire tables at startup, like unsquashfs.
	// The real kernel maintains a cache of metadata instead.
	// (The problem is that directory entries might be split across blocks
	//  at arbitrary points, and we won't care that much about memory usage.)

	this.buffer = new Uint8Array(this.data);

	// First: work out how much space we need.
	var neededSize = 0;
	this.offset = start;
	while (this.offset < end) {
		var c_byte = this.read16() & 0x7fff;
		neededSize += c_byte; // XXX: we ignore compression here
		this.offset = this.offset + c_byte;
	}

	var table_hash = {};
	var table_buffer = new ArrayBuffer(neededSize);

	// Then: fill the buffer, and the hash (with lookups into the buffer).	
	this.offset = start;
	var buffer = new Uint8Array(table_buffer);
	var offset = 0;
	while (this.offset < end) {
		table_hash[this.offset] = offset;
		this.useBlock(this.offset);
		for (var n = 0; n < this.buffer.length; ++n)
			buffer[offset++] = this.buffer[n];
		this.offset = this.nextBlock;
	}

	return [table_buffer, table_hash];
}

SquashFS.prototype.read_id_table = function() {
	this.id_table = [];

	// IDs are stored in metadata blocks.
	var numBytes = this.sBlk.no_ids * 4;
	var numBlocks = ((numBytes + SQUASHFS_METADATA_SIZE - 1) / SQUASHFS_METADATA_SIZE)|0;

	var offsets = [];
	this.offset = this.sBlk.id_table_start;
	for (var n = 0; n < numBlocks; ++n)
		offsets.push(this.read64());

	for (var n = 0; n < numBlocks; ++n) {
		var size = SQUASHFS_METADATA_SIZE;
		if (n == numBlocks-1)
			size = numBytes & (SQUASHFS_METADATA_SIZE-1);
		size = size >> 2;

		this.useBlock(offsets[n]);
		for (var i = 0; i < size; ++i)
			this.id_table.push(this.read32());
	}
}

SquashFS.prototype.readInodeId = function() {
	var offset = this.read16();
	var blk = this.read32();
	var padding = this.read16();
	if (padding != 0) throw SquashFSError("non-zero high bits in inode id");
	return [blk, offset];
}

SquashFS.prototype.read64 = function() {
	// no 64-bit integers in Javascript, but we don't need them.
	var low = this.read32();
	var high = this.read32();
	if (high != 0 && high != 0xffffffff)
		throw SquashFSError("high word of 64-bit integer set (" + high + ")");
	return low;
}

SquashFS.prototype.read32 = function() {
	var v = this.buffer[this.offset];
	v += this.buffer[this.offset + 1] << 8;
	v += this.buffer[this.offset + 2] << 16;
	v += this.buffer[this.offset + 3] << 24;
	this.offset += 4;
	return v>>>0;
}

SquashFS.prototype.read16 = function() {
	var v = this.buffer[this.offset];
	v += this.buffer[this.offset + 1] << 8;
	this.offset += 2;
	return v>>>0;
}

SquashFS.prototype.readString = function(length) {
	var str = "";
	for (var n = 0; n < length; ++n) {
		str += String.fromCharCode(this.buffer[this.offset++]);
	}
	return str;
}
