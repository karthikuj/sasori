import { readFileSync, writeFileSync } from "fs";
import { JSDOM } from 'jsdom';
import crypto from 'crypto'

function stripDOM(node) {
    // If the node is a text node, remove its content
    if (node.nodeType === node.TEXT_NODE) {
        node.nodeValue = '';
    }

    // Remove attributes from element nodes
    if (node.nodeType === node.ELEMENT_NODE) {
        Array.from(node.attributes).forEach(attr => {
            if (['href', 'src'].indexOf(attr.name) == -1) {
                node.removeAttribute(attr.name);
            }
        });
    }

    // Recursively strip child nodes
    node.childNodes.forEach(child => stripDOM(child));
}

const algorithm = 'sha256';

const sampleOne = readFileSync('/home/astra/Dev/foss/sasori/tests/1.html', "UTF-8");
const sampleTwo = readFileSync('/home/astra/Dev/foss/sasori/tests/2.html', "UTF-8");

const sampleOneDom = new JSDOM(sampleOne);
const sampleTwoDom = new JSDOM(sampleTwo);

stripDOM(sampleOneDom.window.document.documentElement);
stripDOM(sampleTwoDom.window.document.documentElement);
sampleOneDom.window.document.documentElement.attributes[0].name

const sampleOneStrippedHtml = sampleOneDom.serialize().replaceAll(' ', '')
const sampleTwoStrippedHtml = sampleTwoDom.serialize().replaceAll(' ', '');

writeFileSync('/home/astra/Dev/foss/sasori/tests/1-stripped.html', sampleOneStrippedHtml);
writeFileSync('/home/astra/Dev/foss/sasori/tests/2-stripped.html', sampleTwoStrippedHtml);

const sampleOneHashDigest = crypto.createHash(algorithm).update(sampleOneStrippedHtml).digest('hex');
const sampleTwoHashDigest = crypto.createHash(algorithm).update(sampleTwoStrippedHtml).digest('hex');

console.log(sampleOneHashDigest);
console.log(sampleTwoHashDigest);