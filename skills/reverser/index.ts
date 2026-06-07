import type { Tool } from "@earendil-works/pi-ai";

export const reverse_string: Tool = {
  name: "reverse_string",
  description: "Reverse a string.",
  parameters: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "The string to reverse",
      },
    },
    required: ["input"],
  },
  execute: (args) => {
    const { input } = args;
    return {
      content: input.split("").reverse().join("")
    };
  },
};

export const reverse_word: Tool = {
  name: "reverse_word",
  description: "Reverse a single word.",
  parameters: {
    type: "object",
    properties: {
      word: {
        type: "string",
        description: "The word to reverse",
      },
    },
    required: ["word"],
  },
  execute: (args) => {
    const { word } = args;
    return {
      content: word.split("").reverse().join("")
    };
  },
};

export const reverse_sentence: Tool = {
  name: "reverse_sentence",
  description: "Reverse a sentence (preserving word order).",
  parameters: {
    type: "object",
    properties: {
      sentence: {
        type: "string",
        description: "The sentence to reverse",
      },
    },
    required: ["sentence"],
  },
  execute: (args) => {
    const { sentence } = args;
    return {
      content: sentence.split(" ").reverse().join(" ")
    };
  },
};

export default {
  reverse_string,
  reverse_word,
  reverse_sentence,
};