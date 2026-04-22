import { render, Text } from "ink";
import SelectInput from "ink-select-input";

interface Item {
  label: string;
  value: string;
}

export async function selectPrompt(
  label: string,
  items: Item[],
  stdin: NodeJS.ReadableStream = process.stdin as NodeJS.ReadableStream
): Promise<string> {
  return new Promise((resolve) => {
    function App() {
      return (
        <>
          <Text>{label}</Text>
          <SelectInput
            items={items}
            onSelect={(item) => {
              unmount();
              resolve(item.value);
            }}
          />
        </>
      );
    }

    const { unmount } = render(<App />, {
      stdout: process.stderr as NodeJS.WriteStream,
      stdin: stdin as NodeJS.ReadStream,
    });
  });
}
