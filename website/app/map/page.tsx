import { Suspense } from 'react';
import MapPageClient from './MapPageClient';

// Server Component:純靜態匯出的殼,把讀 ?s=/?api= 的邏輯留給 client 元件。
// useSearchParams() 在靜態匯出下必須包一層 Suspense,否則 next build 會報錯。
export default function MapPage() {
  return (
    <Suspense fallback={<div className="map2-boot" />}>
      <MapPageClient />
    </Suspense>
  );
}
