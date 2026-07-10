import React, { useEffect, useRef, useState } from 'react';

let _idCounter = 0;
function useUniqueId(prefix: string) {
  const id = useRef<string | null>(null);
  if (!id.current) { id.current = `${prefix}-${++_idCounter}`; }
  return id.current;
}

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}

export function Tooltip({ content, children, placement = 'top', delay = 300 }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLElement>(null);
  const timerId = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tooltipId = useUniqueId('vf-tooltip');

  const show = () => {
    timerId.current = setTimeout(() => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      let top = 0, left = 0;
      if (placement === 'top')    { top = rect.top - 36; left = rect.left + rect.width / 2; }
      if (placement === 'bottom') { top = rect.bottom + 8; left = rect.left + rect.width / 2; }
      if (placement === 'left')   { top = rect.top + rect.height / 2; left = rect.left - 8; }
      if (placement === 'right')  { top = rect.top + rect.height / 2; left = rect.right + 8; }
      setCoords({ top, left });
      setVisible(true);
    }, delay);
  };

  const hide = () => {
    clearTimeout(timerId.current);
    setVisible(false);
  };

  useEffect(() => () => clearTimeout(timerId.current), []);

  const transformMap = {
    top: 'translateX(-50%)',
    bottom: 'translateX(-50%)',
    left: 'translate(-100%, -50%)',
    right: 'translateY(-50%)',
  };

  return (
    <>
      <span
        ref={triggerRef as React.RefObject<HTMLSpanElement>}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        aria-describedby={visible ? tooltipId : undefined}
        style={{ display: 'contents' }}
      >
        {children}
      </span>
      {visible && (
        <div
          id={tooltipId}
          role="tooltip"
          style={{
            position: 'fixed',
            top: coords.top,
            left: coords.left,
            transform: transformMap[placement],
            background: 'var(--vf-elevated)',
            border: '1px solid var(--vf-border-strong)',
            borderRadius: 'var(--vf-radius-sm)',
            color: 'var(--vf-text-primary)',
            fontSize: 'var(--vf-type-caption-size)',
            padding: '5px 9px',
            whiteSpace: 'nowrap',
            zIndex: 2000,
            boxShadow: 'var(--vf-shadow-medium)',
            pointerEvents: 'none',
            animation: 'vf-fade-in 120ms ease',
          }}
        >
          {content}
        </div>
      )}
    </>
  );
}
