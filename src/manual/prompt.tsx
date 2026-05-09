import { render, Text, Box } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { useState } from "react";
import type { FC } from "react";

interface Item {
  label: string;
  value: string;
}

export async function withProgress<T>(message: string, fn: () => Promise<T>): Promise<T> {
  if (!process.stderr.isTTY) return fn();
  const { unmount, clear } = render(
    <Text>
      <Spinner type="sand" />
      {message}
    </Text>,
    { stdout: process.stderr as NodeJS.WriteStream },
  );
  try {
    return await fn();
  } finally {
    clear();
    unmount();
  }
}

export async function textInputPrompt(
  label: string,
  stdin: NodeJS.ReadableStream = process.stdin as NodeJS.ReadableStream,
): Promise<string> {
  return new Promise<string>((resolve) => {
    function App() {
      const [value, setValue] = useState("");
      return (
        <Box>
          <Text>{label}</Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={(val) => {
              clear();
              unmount();
              resolve(val.trim());
            }}
          />
        </Box>
      );
    }

    const { unmount, clear } = render(<App />, { stdout: process.stderr, stdin: stdin as NodeJS.ReadStream });
  });
}

export async function selectPrompt(
  label: string,
  items: Item[],
  stdin: NodeJS.ReadableStream = process.stdin as NodeJS.ReadableStream,
): Promise<string> {
  return new Promise<string>((resolve) => {
    const numberedItems = items.map((item, i) => ({ ...item, label: `${i + 1}. ${item.label}` }));

    function App() {
      return (
        <>
          <Text>{label}</Text>

          <Box height={1} />

          <SelectInput
            items={numberedItems}
            indicatorComponent={Indicator as FC<{ isSelected?: boolean }>}
            itemComponent={ItemText as FC<{ isSelected?: boolean; label: string }>}
            onSelect={(item) => {
              clear();
              unmount();
              resolve(item.value);
            }}
          />
          <Box marginTop={1}>
            <Text dimColor italic>
              ↑↓ to navigate · Enter to select
            </Text>
          </Box>
        </>
      );
    }

    const { unmount, clear } = render(<App />, { stdout: process.stderr, stdin: stdin as NodeJS.ReadStream });
  });
}

function ItemText({ isSelected = false, label }: { isSelected?: boolean; label: string }) {
  const [number, rawText] = label.split(". ", 2);
  const text = rawText ?? "";
  const parts: { text: string; isCode: boolean }[] = [];
  const regex = /\x1b\[94m(.*?)\x1b\[39m/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push({ text: text.slice(lastIndex, match.index), isCode: false });
    parts.push({ text: match[1]!, isCode: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex), isCode: false });
  if (parts.length === 0) parts.push({ text, isCode: false });
  return (
    <Text color={isSelected ? "blueBright" : undefined}>
      <Text dimColor color="white">
        {number ?? ""}.{" "}
      </Text>
      {parts.map((part, i) =>
        part.isCode ? (
          <Text key={i} color={isSelected ? "blue" : "blueBright"}>
            {part.text}
          </Text>
        ) : (
          <Text key={i}>{part.text}</Text>
        ),
      )}
    </Text>
  );
}

function Indicator({ isSelected = false }: { isSelected?: boolean }) {
  return (
    <Box marginRight={1}>
      <Text color="blueBright">{isSelected ? "❯" : " "}</Text>
    </Box>
  );
}
