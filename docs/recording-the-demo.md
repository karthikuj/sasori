# Recording the demo GIF

The animated demo at the top of the README is a recording of Sasori running in a
terminal. This page explains how it was made and how to remake it when the
output changes, for example when the startup banner or the version is updated.

## The two files

Both live in `resources/`.

- **`sasori.yml`** is the source recording. It is a [Terminalizer](https://github.com/faressoft/terminalizer)
  file: a `config` block (terminal size, theme, timing) followed by a `records`
  array of timed terminal frames. This is the file you edit or re-record.
- **`sasori.gif`** is the rendered image that the README points at. It is
  produced from `sasori.yml`. Do not edit it by hand.

The banner text is captured into the frames as plain characters, so you cannot
swap the banner by find and replace. When the banner changes you have to record
again.

## Install Terminalizer

Terminalizer is not a project dependency, so install it when you need it. You can
run it without installing through `npx`:

```bash
npx terminalizer --version
```

Or install it globally:

```bash
npm install -g terminalizer
```

## Record a new run

1. Build first, so the recording shows the current banner and version.

   ```bash
   npm run build
   ```

2. Start the recording. This opens a shell and writes frames to
   `resources/sasori.yml` when you stop.

   ```bash
   npx terminalizer record resources/sasori -d "$SHELL" -k
   ```

   Pass your own shell with `-d "$SHELL"`. Without it, Terminalizer starts
   `bash -l`, a login bash that reads `~/.profile` but not your zsh or bash
   startup files. If Node.js comes from nvm (or anything set up in `~/.zshrc`
   or `~/.bashrc`), that shell has no `node` and no `sasori` on its `PATH`,
   and the recording shows `command not found`. `-k` skips Terminalizer's
   prompt to upload the recording to terminalizer.com.

3. In the recording shell, run a short crawl so the output is visible, then
   leave it running only long enough to show some discovered URLs.

   ```bash
   node dist/bin/index.js start --config ./config/config.json
   ```

   If you installed the command with `make install-app`, `sasori start --config
   ./config/config.json` does the same. Re-run `make install-app` first, so the
   banner shows the version you just built.

4. Stop the crawl with Ctrl+C, then type `exit` to end the recording. Terminalizer
   writes `resources/sasori.yml`.

5. Render the GIF.

   ```bash
   npx terminalizer render resources/sasori.yml -o resources/sasori.gif
   ```

## Keep private details out of the recording

The terminal frames capture whatever is on screen, including your shell prompt
and working directory, and the `config` block records the directory you
recorded in. None of that belongs in a public README. Before recording:

- Record from a neutral directory, not your home or Desktop.
- Trim your prompt so it does not show your username and hostname:

  ```bash
  PS1='$ '
  ```

- Use a plain config whose `entryPoint`, paths, and credentials are not real.
  The committed `config/config.json` points at a public demo site, which is a
  safe choice.

If you recorded with your normal prompt anyway, clean `sasori.yml` before
rendering: replace your `user@host` (it also appears in the invisible
window-title sequences, `\e]0;user@host: …\a`), your working directory, and
the absolute path `sasori init` prints, then set `cwd` to a generic path. Then
check nothing is left, for example `grep -nE "$USER|$(hostname)|$HOME" resources/sasori.yml`.

## Tune the look

You can edit the `config` block at the top of `sasori.yml` before rendering.
A new recording resets that block to Terminalizer's defaults, so copy the
tuned values from the previous `sasori.yml` (in git) instead of starting over.
The committed recording uses `cols: 120`, `rows: 29`, `frameDelay: 100`, the
window title `sasori`, and no box shadow with a 4px margin.


- **`cols` and `rows`** set the terminal size. Smaller values make a tighter GIF.
- **`frameDelay`** controls playback speed. `auto` keeps your real typing pace,
  a fixed value in milliseconds makes it even.
- **`quality`** ranges from 1 to 100.
- **`theme`** sets the colors.

zsh pads the line before each prompt to the width of the terminal you
recorded in. If you recorded in a wider terminal than `cols`, those runs of
spaces wrap and add a blank line before every prompt: shorten them to
`cols - 1` spaces.

Re-render after any edit.

## Commit the result

Commit both files together so the source and the image stay in step:

```bash
git add resources/sasori.yml resources/sasori.gif
git commit -m "docs: re-record the demo GIF"
```

The README references `resources/sasori.gif`, so no README change is needed
unless you rename the file.
