function ELFFile(buffer) {
	var u8a = new Uint8Array(buffer);
	var u16a = new Uint16Array(buffer);
	var u32a = new Uint32Array(buffer);
	if (u8a[0] != 0x7f || u8a[1] != 0x45 || u8a[2] != 0x4c || u8a[3] != 0x46)
		throw Error("not ELF file");
	if (u8a[4] != 1)
		throw Error("ELF not 32-bit");
	if (u8a[5] != 1)
		throw Error("ELF not little-endian");
	if (u8a[6] != 1)
		throw Error("wrong ELF version");
	this.objType = u16a[8];
	switch (this.objType) {
	case ET_EXEC:
		break;
	case ET_DYN:
		break;
	default:
		throw Error("unsupported ELF type " + this.objType);
	}
	this.machineType = u16a[9];
	if (this.machineType != 8)
		throw Error("ELF is not MIPS but " + this.machineType);
	if (u32a[5] != 1)
		throw Error("wrong ELF version " + u32a[10]);
	this.entryPoint = u32a[6];
	this.phOffset = u32a[7];
	this.flags = u32a[9]; // TODO: handle
	this.phEntSize = u16a[21];
	if (this.phEntSize != 32)
		throw Error("bad e_phentsize " + this.phEntSize);
	this.phNum = u16a[22];

	this.elf_interpreter = "";

	// TODO: We just quietly assume headers/sections are aligned.
	this.headers = [];
	for (var p = 0; p < this.phNum; ++p) {
		var thisOffset = (this.phOffset + p*this.phEntSize) >>> 2;

		var header = new Object();

		header.pType = u32a[thisOffset + 0];
		header.pOffset = u32a[thisOffset + 1];
		header.pVAddr = u32a[thisOffset + 2];
		header.pFileSz = u32a[thisOffset + 4];
		header.pMemSz = u32a[thisOffset + 5];
		header.pFlags = u32a[thisOffset + 6]; // FIXME: obey
		header.pAlign = u32a[thisOffset + 7];

		switch (header.pType) {
		case 3: // PT_INTERP
			// TODO: check there aren't multiple?
			for (var b = 0; b < header.pFileSz-1; ++b) {
				this.elf_interpreter = this.elf_interpreter + String.fromCharCode(u8a[header.pOffset + b]);
			}
			// TODO: check the last byte was a null
			break;
		}

		this.headers.push(header);
	}
}
