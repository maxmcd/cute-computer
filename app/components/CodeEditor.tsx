import { Editor } from "@monaco-editor/react";

interface CodeEditorProps {
  value: string;
  onChange: (code: string) => void;
  language: string;
  readOnly?: boolean;
}

export function CodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
}: CodeEditorProps) {
  return (
    <div className="h-full overflow-hidden bg-white">
      <Editor
        value={value}
        onChange={(newValue) => onChange(newValue || "")}
        language={language}
        theme="vs" // Light theme
        options={{
          lineNumbers: "on",
          minimap: { enabled: false },
          fontSize: 14,
          fontFamily: "JetBrains Mono, Menlo, Monaco, monospace",
          automaticLayout: true,
          scrollBeyondLastLine: false,
          wordWrap: "off",
          readOnly: readOnly,
          tabSize: 2,
          insertSpaces: true,
          quickSuggestions: true,
          suggestOnTriggerCharacters: true,
          acceptSuggestionOnEnter: "on",
          formatOnPaste: true,
          formatOnType: true,
        }}
        loading={
          <div className="flex items-center justify-center h-full text-gray-600 text-sm"></div>
        }
      />
    </div>
  );
}
