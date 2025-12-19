import type { ReactNode } from "react";

interface WindowProps {
  title: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  rightContent?: ReactNode;
}

export function Window({
  title,
  onClose,
  children,
  rightContent,
}: WindowProps) {
  return (
    <div className="bg-white rounded-xl shadow-2xl overflow-hidden">
      {/* Title Bar */}
      <div className="bg-gradient-to-r from-pink-300 to-purple-300 px-4 py-3 flex items-center gap-3 border-b border-purple-400">
        {/* Traffic Lights */}
        {onClose && (
          <div className="flex gap-2 cursor-pointer">
            <div
              onClick={onClose}
              className="w-3 h-3 rounded-full bg-pink-400"
            ></div>
            <div className="w-3 h-3 rounded-full bg-purple-400"></div>
            <div className="w-3 h-3 rounded-full bg-indigo-400"></div>
          </div>
        )}

        {/* Title */}
        <span className="flex-1 text-center text-purple-900 text-[13px] font-medium font-mono tracking-wide">
          {title}
        </span>

        {/* Right Content (status, etc.) */}
        {rightContent && <div className="ml-auto">{rightContent}</div>}
      </div>

      {/* Window Content */}
      {children}
    </div>
  );
}
