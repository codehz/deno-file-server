import { ce, attr, discard, on } from "https://codehz.github.io/KISS.js/kiss.js";
import marked from 'https://cdn.skypack.dev/marked';

const README = await (await fetch("README.md")).text();

export default ce('div', attr({
  innerHTML: marked(README)
}));