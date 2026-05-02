export default function MapLegend() {
  return (
    <div className="flex flex-wrap gap-6 text-sm text-[#0E0E0E]/80">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block w-3 h-4"
          style={{
            backgroundColor: '#4F7A3F',
            border: '1.5px solid #2A4A20',
            borderRadius: '6px 6px 0 50%',
          }}
        />
        <span>
          <strong>Verified partner</strong> — shipping today via BuyHalfCow
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block w-3 h-4"
          style={{
            backgroundColor: '#A7A29A',
            border: '1.5px dashed #0E0E0E',
            borderRadius: '6px 6px 0 50%',
          }}
        />
        <span>
          <strong>Prospect</strong> — direct-to-consumer rancher we&rsquo;re working
          to bring in. Unclaimed.
        </span>
      </div>
    </div>
  );
}
