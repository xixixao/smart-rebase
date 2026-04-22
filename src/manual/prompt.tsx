import { render, Text, Box } from "ink";
import SelectInput from "ink-select-input";
import type { FC } from "react";

interface Item {
  label: string;
  value: string;
}

function Indicator({ isSelected = false }: { isSelected?: boolean }) {
  return (
    <Box marginRight={1}>
      <Text color="blueBright">{isSelected ? "❯" : " "}</Text>
    </Box>
  );
}

function ItemText({ isSelected = false, label }: { isSelected?: boolean; label: string }) {
  const [number,text] = label.split(". ", 2);
  return <Text color={isSelected ? "blueBright" : undefined}><Text dimColor color="white">{number}. </Text>{text}</Text>;
}

export async function selectPrompt(
  label: string,
  items: Item[],
  stdin: NodeJS.ReadableStream = process.stdin as NodeJS.ReadableStream
): Promise<string> {
  return new Promise((resolve) => {
    const numberedItems = items.map((item, i) => ({
      ...item,
      label: `${i + 1}. ${item.label}`,
    }));

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
              unmount();
              resolve(item.value);
            }}
          />
          <Box marginTop={1}>
            <Text dimColor>↑↓ to navigate · Enter to select · Esc to back</Text>
          </Box>
        </>
      );
    }

    const { unmount } = render(<App />, {
      stdout: process.stderr as NodeJS.WriteStream,
      stdin: stdin as NodeJS.ReadStream,
    });
  });
}
