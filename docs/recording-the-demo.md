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
   npx terminalizer record resources/sasori
   ```

3. In the recording shell, run a short crawl so the output is visible, then
   leave it running only long enough to show some discovered URLs.

   ```bash
   node dist/bin/index.js start --config ./config/config.json
   ```

4. Stop the crawl with Ctrl+C, then type `exit` to end the recording. Terminalizer
   writes `resources/sasori.yml`.

5. Render the GIF.

   ```bash
   npx terminalizer render resources/sasori.yml -o resources/sasori.gif
   ```

## Keep private details out of the recording

The terminal frames capture whatever is on screen, including your shell prompt
and working directory. The current `sasori.yml` shows a real home path and
hostname, which we do not want in a public README. Before recording:

- Record from a neutral directory, not your home or Desktop.
- Trim your prompt so it does not show your username and hostname:

  ```bash
  PS1='$ '
  ```

- Use a plain config whose `entryPoint`, paths, and credentials are not real.
  The committed `config/config.json` points at a public demo site, which is a
  safe choice.

## Tune the look

You can edit the `config` block at the top of `sasori.yml` before rendering:

- **`cols` and `rows`** set the terminal size. Smaller values make a tighter GIF.
- **`frameDelay`** controls playback speed. `auto` keeps your real typing pace,
  a fixed value in milliseconds makes it even.
- **`quality`** ranges from 1 to 100.
- **`theme`** sets the colors.

Re-render after any edit.

## Commit the result

Commit both files together so the source and the image stay in step:

```bash
git add resources/sasori.yml resources/sasori.gif
git commit -m "docs: re-record the demo GIF"
```

The README references `resources/sasori.gif`, so no README change is needed
unless you rename the file.
