import React from 'react';
import { Avatar } from '@badminton/ui';

const jordanSrc =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56"><rect width="56" height="56" fill="%23e8d9c0"/><circle cx="28" cy="21" r="10" fill="%23a06a3c"/><path d="M8 56c0-12 9-18 20-18s20 6 20 18z" fill="%23345b7a"/></svg>`.replace(/%23/g, '#')
  );

export function InitialsSizes() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <Avatar name="Jordan Lee" size="sm" />
      <Avatar name="Priya Patel" size="md" />
      <Avatar name="Marcus Wong" size="lg" />
    </div>
  );
}

export function WithPhoto() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <Avatar name="Jordan Lee" src={jordanSrc} size="lg" />
      <Avatar name="Jordan Lee" src={jordanSrc} size="md" />
      <Avatar name="Jordan Lee" src={jordanSrc} size="sm" />
    </div>
  );
}

export function BrokenSrcFallback() {
  // src 404s → onError swaps to the initials disc
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <Avatar name="Aiko Tanaka" src="/uploads/missing-photo.jpg" size="md" />
      <Avatar name="Sam Osei" src="/uploads/also-missing.jpg" size="md" />
    </div>
  );
}
