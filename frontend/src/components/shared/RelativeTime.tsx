interface RelativeTimeProps {
  date: Date | string;
}

export function RelativeTime({ date }: RelativeTimeProps) {
  const time = new Date(date).getTime();
  const now = Date.now();
  const difference = Math.floor((now - time) / 1000);

  if (difference < 60) {
    return <span>just now</span>;
  }

  if (difference < 3600) {
    const minutes = Math.floor(difference / 60);
    return <span>{minutes}m ago</span>;
  }

  if (difference < 86400) {
    const hours = Math.floor(difference / 3600);
    return <span>{hours}h ago</span>;
  }

  const days = Math.floor(difference / 86400);
  return <span>{days}d ago</span>;
}
