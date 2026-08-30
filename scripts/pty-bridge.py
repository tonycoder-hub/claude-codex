import pty, os, sys, select, struct, fcntl, termios, signal, json, base64, threading, time

def set_winsize(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except Exception:
        pass

def cleanup_child(pid):
    try:
        os.killpg(pid, signal.SIGTERM)
    except Exception:
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass
    for _ in range(10):
        try:
            res, _ = os.waitpid(pid, os.WNOHANG)
            if res != 0:
                return
        except Exception:
            return
        time.sleep(0.02)
    try:
        os.killpg(pid, signal.SIGKILL)
    except Exception:
        try:
            os.kill(pid, signal.SIGKILL)
        except Exception:
            pass

def main():
    if len(sys.argv) < 2:
        sys.exit(1)
    cmd = sys.argv[1:]
    master, slave = pty.openpty()
    pid = os.fork()
    if pid == 0:
        os.close(master)
        os.setsid()
        os.dup2(slave, 0)
        os.dup2(slave, 1)
        os.dup2(slave, 2)
        os.close(slave)
        try:
            os.execvp(cmd[0], cmd)
        except Exception:
            sys.exit(127)
    os.close(slave)

    def pty_reader():
        try:
            while True:
                data = os.read(master, 4096)
                if not data:
                    break
                msg = json.dumps({"stream": "stdout", "delta": base64.b64encode(data).decode("ascii")})
                sys.stdout.write(msg + "\n")
                sys.stdout.flush()
        except Exception:
            pass

    t = threading.Thread(target=pty_reader, daemon=True)
    t.start()

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                cmd_obj = json.loads(line)
                action = cmd_obj.get("action")
                if action == "input":
                    raw = base64.b64decode(cmd_obj.get("data", ""))
                    os.write(master, raw)
                elif action == "resize":
                    cols = int(cmd_obj.get("cols", 80))
                    rows = int(cmd_obj.get("rows", 24))
                    set_winsize(master, rows, cols)
                elif action == "kill":
                    cleanup_child(pid)
                    break
            except Exception:
                pass

    except Exception:
        pass

    finally:
        cleanup_child(pid)

if __name__ == "__main__":
    main()
