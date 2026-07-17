# Contributing

Contributions are welcome. Please open an issue before a large change so the approach can be discussed first.

## Development

1. Fork and clone the repository.
2. Install Node.js 18 or newer, yt-dlp, and ffmpeg.
3. Load the repository folder as an unpacked extension from `chrome://extensions`.
4. Run the checks before submitting a pull request:

   ```bash
   npm run check
   npm test
   ```

Keep changes focused and include tests for server or native-host behavior where practical. Never commit cookies, authentication headers, downloaded media, logs, or local environment files.

By contributing, you agree that your contribution will be licensed under the MIT License.
