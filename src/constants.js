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
var CLONE_VM = 0x100;
var CLONE_FS = 0x200;
var CLONE_FILES = 0x400;
var CLONE_SIGHAND = 0x800;
var CLONE_PTRACE = 0x2000;
var CLONE_VFORK = 0x4000;
var CLONE_PARENT = 0x8000;
var CLONE_THREAD = 0x10000;
var CLONE_NEWNS = 0x20000;
var CLONE_SYSVSEM = 0x40000;
var CLONE_SETTLS = 0x80000;
var CLONE_PARENT_SETTID = 0x00100000;
var CLONE_CHILD_CLEARTID = 0x00200000;
var CLONE_DETACHED = 0x00400000;
var CLONE_UNTRACED = 0x00800000;
var CLONE_CHILD_SETTID = 0x01000000;
var CLONE_NEWUTS = 0x04000000;
var CLONE_NEWIPC = 0x08000000;
var CLONE_NEWUSER = 0x10000000;
var CLONE_NEWPID = 0x20000000;
var CLONE_NEWNET = 0x40000000;
var CLONE_IO = 0x80000000;

var S_IFLNK = 0xa000;
var S_IFREG = 0x8000;
var S_IFDIR = 0x4000;
var S_IFCHR = 0x2000;
var S_IFBLK = 0x6000;

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

const PROT_NONE = 0x0;
const PROT_READ = 0x1;
const PROT_WRITE = 0x2;
const PROT_EXEC = 0x4;

// Linux-internal
const VM_SHARED = 0x8;

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

// termios
var NCCS = 23;
var VINTR = 0;
var VQUIT = 1;
var VERASE = 2;
var VKILL = 3;
var VMIN = 4;
var VTIME = 5;
var VEOL2 = 6;
var VSWTC = 7;
var VSTART = 8;
var VSTOP = 9;
var VSUSP = 10;
var VREPRINT = 12;
var VDISCARD = 13;
var VWERASE = 14;
var VLNEXT = 15;
var VEOF = 16;
var VEOL = 17;
var IGNBRK = 0x1;
var BRKINT = 0x2;
var IGNPAR = 0x4;
var PARMRK = 0x8;
var INPCK = 0x10;
var ISTRIP = 0x20;
var INLCR = 0x40;
var IGNCR = 0x80;
var ICRNL = 0x100;
var IUCLC = 0x200;
var IXON = 0x400;
var IXANY = 0x800;
var IXOFF = 0x1000;
var IMAXBEL = 0x2000;
var IUTF8 = 0x4000;
var OPOST = 0x1;
var OLCUC = 0x2;
var ONLCR = 0x4;
var OCRNL = 0x8;
var ONOCR = 0x10;
var ONLRET = 0x20;
var OFILL = 0x40;
var OFDEL = 0x80;
var NLDLY = 0x100;
var TABDLY = 0x1800;
var XTABS = 0x1800;
var CBAUD = 0x100f;
var B38400 = 0xf;
var CSIZE = 0x30;
var CS8 = 0x30;
var CSTOPB = 0x40;
var CREAD = 0x80;
var PARENB = 0x100;
var PARODD = 0x200;
var HUPCL = 0x400;
var CLOCAL = 0x800;
var CBAUDEX = 0x1000;
var ISIG = 0x1;
var ICANON = 0x2;
var XCASE = 0x4;
var ECHO = 0x8;
var ECHOE = 0x10;
var ECHOK = 0x20;
var ECHONL = 0x40;
var NOFLSH = 0x80;
var IEXTEN = 0x100;
var ECHOCTL = 0x200;
var ECHOPRT = 0x400;
var ECHOKE = 0x800;
var FLUSHO = 0x2000;
var PENDIN = 0x4000;
var TOSTOP = 0x8000;
var EXTPROC = 0x10000;

// signals
var SIGHUP = 1;
var SIGINT = 2;
var SIGQUIT = 3;
var SIGILL = 4;
var SIGTRAP = 5;
var SIGIOT = 6;
var SIGABRT = SIGIOT;
var SIGEMT = 7;
var SIGFPE = 8;
var SIGKILL = 9;
var SIGBUS = 10;
var SIGSEGV = 11;
var SIGSYS = 12;
var SIGPIPE = 13;
var SIGALRM = 14;
var SIGTERM = 15;
var SIGUSR1 = 16;
var SIGUSR2 = 17;
var SIGCHLD = 18;
var SIGPWR = 19;
var SIGWINCH = 20;
var SIGURG = 21;
var SIGIO = 22;
var SIGPOLL = SIGIO;
var SIGSTOP = 23;
var SIGTSTP = 24;
var SIGCONT = 25;
var SIGTTIN = 26;
var SIGTTOU = 27;
var SIGVTALRM = 28;
var SIGPROF = 29;
var SIGXCPU = 30;
var SIGXFSZ = 31;
var SIGRTMIN = 32;
var _NSIG = 128;
var SIGRTMAX = 128;
var SA_ONSTACK = 0x08000000;
var SA_ONESHOT = 0x80000000;
var SA_RESTART = 0x10000000;
var SA_SIGINFO = 0x00000008;
var SA_NODEFER = 0x40000000;
var SA_NOCLDWAIT = 0x00010000;
var SA_NOCLDSTOP = 0x00000001;
var SIG_BLOCK = 1;
var SIG_UNBLOCK = 2;
var SIG_SETMASK = 3;
var SIG_DFL = 0;
var SIG_IGN = 1;
var SIG_ERR = -1;

