/* all this is GPLv2+ */

// error codes
var EPERM = 1;
var ENOENT = 2;
var ESRCH = 3;
var EINTR = 4;
var EIO = 5;
var ENXIO = 6;
var E2BIG = 7;
var ENOEXEC = 8;
var EBADF = 9;
var ECHILD = 10;
var EAGAIN = 11;
var ENOMEM = 12;
var EACCES = 13;
var EFAULT = 14;
var ENOTBLK = 15;
var EBUSY = 16;
var EEXIST = 17;
var EXDEV = 18;
var ENODEV = 19;
var ENOTDIR = 20;
var EISDIR = 21;
var EINVAL = 22;
var ENFILE = 23;
var EMFILE = 24;
var ENOTTY = 25;
var ETXTBSY = 26;
var EFBIG = 27;
var ENOSPC = 28;
var ESPIPE = 29;
var EROFS = 30;
var EMLINK = 31;
var EPIPE = 32;
var EDOM = 33;
var ERANGE = 34;

// arch/mips/include/uapi/asm/errno.h
var ENOSYS = 89;
var ELOOP = 90;
var ERESTART = 91;
var ESTRPIPE = 92;
var ENOTEMPTY = 93;
var EUSERS = 94;
var ENOTSOCK = 95;

// clone flags
var CLONE_PARENT_SETTID = 0x00100000;
var CLONE_CHILD_CLEARTID = 0x00200000;
var CLONE_CHILD_SETTID = 0x01000000;

var S_IFLNK = 0xa000;
var S_IFREG = 0x8000;
var S_IFDIR = 0x4000;

// mips poll values
var POLLIN = 0x1;
var POLLPRI = 0x2;
var POLLOUT = 0x4;
var POLLERR = 0x8;
var POLLHUP = 0x10;
var POLLNVAL = 0x20;
var POLLRDNORM = 0x40;
var POLLRDBAND = 0x80;
var POLLWRNORM = POLLOUT;
var POLLWRBAND = 0x100;
var POLLMSG = 0x400;
var POLLREMOVE = 0x1000;
var POLLRDHUP = 0x2000;

// wait
var WNOHANG = 0x1;

// ELF
var ET_EXEC = 2;
var ET_DYN = 3;

var SEEK_SET = 0;
var SEEK_CUR = 1;
var SEEK_END = 2;

// mmap (mips)
var MAP_SHARED = 1;
var MAP_PRIVATE = 2;
var MAP_FIXED = 0x10;
var MAP_NORESERVE = 0x400;
var MAP_ANONYMOUS = 0x800;
var MAP_GROWSDOWN = 0x1000;
var MAP_DENYWRITE = 0x2000;
var MAP_EXECUTABLE = 0x4000;
var MAP_LOCKED = 0x8000;
var MAP_POPULATE = 0x10000;
var MAP_NONBLOCK = 0x20000;
var MAP_STACK = 0x40000;
var MAP_HUGETLB = 0x80000;

var PROT_NONE = 0x0;
var PROT_READ = 0x1;
var PROT_WRITE = 0x2;
var PROT_EXEC = 0x4;

// Linux-internal
var VM_SHARED = 0x8;

// fcntl (mips)
var O_APPEND = 8;
var O_DSYNC = 0x10;
var O_NONBLOCK = 0x80;
var O_CREAT = 0x100;
var O_TRUNC = 0x200;
var O_EXCL = 0x400;
var O_NOCTTY = 0x800;
var FASYNC = 0x1000;
var O_LARGEFILE = 0x2000;
var __O_SYNC = 0x4000;
var O_SYNC = O_SYNC | O_DSYNC;
var O_DIRECT = 0x8000;
var O_DIRECTORY = 0x10000;
var O_NOFOLLOW = 0x20000;
var O_NOATIME = 0x40000;
var O_CLOEXEC = 0x80000;
var O_PATH = 0x200000;
var __O_TMPFILE = 0x400000;
// "a horrid kludge trying to make sure that this will fail on old kernels"
// TODO: do we need this?
var O_TMPFILE = (__O_TMPFILE | O_DIRECTORY);
var O_TMPFILE_MASK = (__O_TMPFILE | O_DIRECTORY | O_CREAT);

var F_DUPFD = 0;
var F_GETFD = 1;
var F_SETFD = 2;
var F_GETFL = 3;
var F_SETFL = 4;
var F_GETLK = 14; // mips
var F_SETLK = 6;
var F_SETLKW = 7;
var F_SETOWN = 24; // mips
var F_GETOWN = 23; // mips
var F_SETSIG = 10;
var F_GETSIG = 11;
var F_SETOWN_EX = 15;
var F_GETOWN_EX = 16;
var F_GETOWNER_UIDS = 17;
var F_OFD_GETLK = 36;
var F_OFD_SETLK = 37;
var F_OFD_SETLKW = 38;
