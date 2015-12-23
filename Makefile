SRCS = header.js external/localforage.min.js src/constants.js src/noopfs.js src/squashfs.js src/syscalls.js src/elf.js src/process.js src/startup.js

all: noopsys.js

noopsys.js: $(SRCS)
	cat $(SRCS) > noopsys.js
