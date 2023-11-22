window.addEventListener("DOMContentLoaded", () => {
    const replaceText = (selector: string, text: string | undefined) => {
        const element = document.querySelector(selector);
        if (element) {
            element.innerHTML = text ? text : "";
        }
    };

    ["chrome", "node", "electron"].forEach(element => {
        replaceText(`#${element}-version`, process.versions[element]);
    });
});