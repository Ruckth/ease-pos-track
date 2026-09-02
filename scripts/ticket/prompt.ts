import { closeSync, openSync } from "node:fs";
import { ReadStream, WriteStream } from "node:tty";
import { authError, type TicketCliError } from "./errors";

/** Reads a password from the controlling terminal without echoing any character. */
export async function readHiddenPassword() {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    throw authError(
      "INTERACTIVE_TERMINAL_REQUIRED",
      "Staff login requires an interactive terminal for the hidden password prompt.",
      "Run `pnpm ticket login` in an interactive terminal.",
    );
  }

  const input = new ReadStream(fd);
  const output = new WriteStream(fd);
  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();
  output.write("Staff password: ");

  return await new Promise<string>((resolve, reject) => {
    let password = "";
    const finish = (error?: TicketCliError) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      closeSync(fd);
      if (error) reject(error);
      else resolve(password);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") return finish(authError("LOGIN_CANCELLED", "Login was cancelled."));
        if (character === "\u007f" || character === "\b") password = password.slice(0, -1);
        else if (character >= " ") password += character;
      }
    };
    input.on("data", onData);
  });
}
