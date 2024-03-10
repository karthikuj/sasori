<h1 align="center">
  <br>
  <a href="https://github.com/karthikuj/sasori"><img src="./resources/sasori-logo.png" alt="Sasori Logo" width="200" /></a>
  <br>
  Sasori: Dynamic Web Crawler
  <br>
</h1>

## Project Description:
Sasori is a powerful and flexible dynamic web crawler built on Puppeteer. It allows you to automate the crawling of web applications, even those behind authentication, offers seamless integration with security testing tools like ZAP or Burp Suite and provides customizable configurations for enhanced flexibility.


## Features
- **Dynamic Crawling:** Sasori excels at crawling dynamic web applications, handling AJAX-loaded content, and interacting with complex user interfaces.

- **Authentication Support:** Easily spider applications behind authentication barriers by passing the puppeteer recording for the login sequence.

- **Proxy Integration:** Sasori provides the option to set up a proxy server, allowing you to route requests through tools like Zaproxy or Burp Suite for security testing.

- **State-Based Navigation:** The project is designed around a state-based system, keeping track of URLs, DOM structures, and interactable elements for efficient crawling.

- **Efficient Endpoint Coverage:** Utilizes efficient algorithms for intelligent crawling, ensuring coverage of more endpoints while maintaining speed.


## Getting Started:
To get started with Sasori, follow these steps:

1. Clone the repository:
```bash
git clone https://github.com/your_username/sasori.git
```

2. Install dependencies:
```bash
cd sasori
npm install
```

3. Configure Sasori by editing the configuration file in the `config` directory.

4. Run Sasori:
```bash
npm start
```


## Configuration:
Sasori offers various configuration options to customize its behavior. These include:

- Headless and Headful modes.
- Proxy server settings for integration with Zaproxy or Burp Suite.
- Customize crawl elements.
- Authentication recording.
- Max duration.
- Regexes for scope management.


## Examples:
Here are some examples demonstrating the usage of Sasori in real-world scenarios:

- Crawling a web application behind authentication.
- Integrating Sasori with Zaproxy or Burp Suite for security testing.
- Customizing crawling parameters for specific use cases.


## Contributing:
Contributions to Sasori are welcome! If you encounter any bugs, have feature requests, or would like to contribute code improvements, please follow the guidelines in the CONTRIBUTING.md file.


## License:
Needs to be updated