import React from 'react';

function classes(...c: Array<string | undefined | false>) {
  return c.filter(Boolean).join(' ');
}

export function FadeIn({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const style = delay > 0 ? { animationDelay: `${Math.round(delay * 1000)}ms` } : undefined;
  return (
    <div className={classes('reveal', className)} style={style}>
      {children}
    </div>
  );
}

export function StaggerContainer({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      {React.Children.map(children, (child, i) => {
        if (!React.isValidElement(child)) return child;
        const existingStyle = (child.props as { style?: React.CSSProperties }).style ?? {};
        return React.cloneElement(child as React.ReactElement<{ style?: React.CSSProperties }>, {
          style: {
            ...existingStyle,
            animationDelay: `${Math.min(i * 60, 500)}ms`,
          },
        });
      })}
    </div>
  );
}

export function StaggerItem({
  children,
  className,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={classes('reveal', className)} style={style}>
      {children}
    </div>
  );
}
