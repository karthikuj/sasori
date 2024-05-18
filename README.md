<h1 align="center">
  <br>
  <img src="https://karthikuj.github.io/images/sasori-logo.png" alt="Sasori Logo" width="200" />
  <br>
  Sasori: Dynamic Web Crawler
  <br>
</h1>

<p align="center"><img src="https://karthikuj.github.io/images/sasori.gif" alt="Sasori Demo" width="700" /></p>

## Project Description:

Sasori is a powerful and flexible dynamic web crawler built on Puppeteer. It allows you to automate the crawling of web applications, even those behind authentication, offers seamless integration with security testing tools like Zaproxy or Burp Suite and provides customizable configurations for enhanced flexibility.

## Features

- **Dynamic Crawling:** Sasori excels at crawling dynamic web applications, handling AJAX-loaded content, and interacting with complex user interfaces.

- **Authentication Support:** Easily spider applications behind authentication barriers by passing the puppeteer recording for the login sequence.

- **Proxy Integration:** Sasori provides the option to set up a proxy server, allowing you to route requests through tools like Zaproxy or Burp Suite for security testing.

- **State-Based Navigation:** The project is designed around a state-based system, keeping track of URLs, DOM structures, and interactable elements for efficient crawling.

- **Efficient Endpoint Coverage:** Utilizes efficient algorithms for intelligent crawling, ensuring coverage of more endpoints while maintaining speed.

- **Crawl Customization:** Allows you to customize what elements to interact with to target specific use cases.

## Getting Started:

To get started with Sasori, follow these steps:

### Recommended

1. Install the package globally:

```bash
npm install -g sasori-crawl
```

2. Create Sasori's configuration file:

```bash
sasori init
```

3. Edit the configuration file. Check [Configuration](#configuration)

4. Run Sasori:

```bash
sasori start --config /path/to/config.json
```

### Alternative

1. Clone the repository:

```bash
git clone https://github.com/karthikuj/sasori.git
```

2. Install dependencies:

```bash
cd sasori
npm install
```

3. Configure Sasori by editing the configuration file in the `config` directory. Check [Configuration](#configuration).

4. Run Sasori:

```bash
node . start --config ./config/config.json
```

## Configuration

The Sasori configuration consists of two main sections: `browser` and `crawler`. Each section contains specific settings to customize the behavior of the crawler and the browser used for crawling.

### Browser Configuration

The `browser` section contains settings related to the browser used by the crawler.

- **headless**: (boolean) Specifies whether the browser should run in headless mode. Default: `false`.
- **maximize**: (boolean) Specifies whether the browser window should be maximized. Default: `false`.
- **proxy**: (object) Configuration for proxy settings.
  - **enabled**: (boolean) Specifies whether proxy is enabled.
  - **host**: (string) Hostname of the proxy server. Required if `enabled` is `true`.
  - **port**: (integer) Port of the proxy server. Required if `enabled` is `true`.

Example:

```json
{
  "browser": {
    "headless": true,
    "maximize": false,
    "proxy": {
      "enabled": true,
      "host": "proxy.example.com",
      "port": 8080
    }
  }
}
```

### Crawler Configuration

The `crawler` section contains settings related to the behavior of the crawler.

- **entryPoint**: (string) URL of the entry point from where the crawling starts. Required.
- **eventTimeout**: (integer) Timeout (in milliseconds) for waiting for events during crawling. Required.
- **navigationTimeout**: (integer) Timeout (in milliseconds) for waiting for navigation to complete during crawling. Required.
- **eventWait**: (integer) Timeout (in milliseconds) for waiting between events during crawling. Required.
- **maxDuration**: (integer) Maximum duration (in milliseconds) for the crawling process. `0` means crawl indefinitely. Required.
- **elements**: (array of css paths) List of HTML css paths to click during crawling. Required.
- **maxChildren**: (integer) Maximum number of child elements to crawl from each parent state. `0` means infinite children. Required.
- **maxDepth**: (integer) Maximum depth of the crawling process. `0` means infinite depth. Required.
- **authentication**: (object) Authentication settings for crawler.
  - **basicAuth**: (object) Configuration for HTTP basic authentication.
    - **enabled**: (boolean) Specifies whether basic authentication is enabled.
    - **username**: (string) Username for basic authentication. Required if `enabled` is `true`.
    - **password**: (string) Password for basic authentication. Required if `enabled` is `true`.
  - **recorderAuth**: (object) Configuration for recorder based authentication.
    - **enabled**: (boolean) Specifies whether recorder based authentication is enabled.
    - **pptrRecording**: (string) Path to [Puppeteer recording](#creating-a-puppeteer-recording) for authentication. Required if `enabled` is `true`.

Example:

```json
{
  "crawler": {
    "entryPoint": "https://example.com",
    "eventTimeout": 10000,
    "navigationTimeout": 30000,
    "eventWait": 1000,
    "maxDuration": 600000,
    "elements": ["a", "button", "input[type=\"submit\"]"],
    "maxChildren": 10,
    "maxDepth": 5,
    "authentication": {
      "basicAuth": {
        "enabled": true,
        "username": "user",
        "password": "password"
      },
      "recorderAuth": {
        "enabled": false,
        "pptrRecording": "/path/to/pptr/recording.json"
      }
    },
    "includeRegexes": ["https?://example\\.com(?:/.*|)"],
    "excludeRegexes": ["^.*\\.pdf$", "https?://example\\.com/logout"]
  }
}
```

### Creating a puppeteer recording
1. Open DevTools in Google Chrome and click on the 3 dots icon in the top-right corner.

![DevTools Options](https://karthikuj.github.io/images/devtools-options.png)

2. Go to `More tools` > `Recorder`.

![Recorder](https://karthikuj.github.io/images/recorder.png)

3. Click on `Create a new recording`.

4. Give a name to your recording and then click on `Start recording`.

5. Create the recording and then click on `End recording`.

![Create Recording](https://karthikuj.github.io/images/create-recording.gif)

6. Lastly export the recording by clicking on the downward arrow and then choosing `JSON` as the type.

![Export Recording](https://karthikuj.github.io/images/export-recording.png)

## Contributing:

Contributions to Sasori are welcome! If you encounter any bugs, have feature requests, or would like to contribute code improvements, please follow the guidelines in the [CONTRIBUTING.md](CONTRIBUTING.md) file.

## License:

This project is licensed under the [MIT License](LICENSE).
