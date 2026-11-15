"""Give a subprocess a controlling terminal on macOS and Linux, without packages."""
import errno
import os
import pty
import select
import sys

pid, terminal = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])

sources = [terminal, sys.stdin.fileno()]
while True:
    ready, _, _ = select.select(sources, [], [])
    if terminal in ready:
        try:
            data = os.read(terminal, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break
        if not data:
            break
        os.write(sys.stdout.fileno(), data)
    if sys.stdin.fileno() in ready:
        data = os.read(sys.stdin.fileno(), 65536)
        if data:
            os.write(terminal, data)
        else:
            sources.remove(sys.stdin.fileno())

os.close(terminal)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
