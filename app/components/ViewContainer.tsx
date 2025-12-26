import type { ReactNode } from "react";
import { BackLink } from "./BackLink";

interface ViewContainerProps {
  computerName: string;
  children: ReactNode;
}

export function ViewContainer({ computerName, children }: ViewContainerProps) {
  return (
    <div className="h-screen w-full flex flex-col bg-gradient-to-br from-pink-200 via-purple-200 to-indigo-300 p-4 md:p-10">
      <div className="w-full flex-1 flex flex-col min-h-0">
        <BackLink href={`/computer/${computerName}`} />
        {children}
      </div>
    </div>
  );
}
