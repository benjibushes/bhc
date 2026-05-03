export default function MapLegend() {
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm text-[#0E0E0E]/80">
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="inline-block w-3 h-4 shrink-0 mt-0.5"
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
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="inline-block w-3 h-4 shrink-0 mt-0.5"
          style={{
            backgroundColor: '#D97757',
            border: '1.5px solid #8C3D1F',
            borderRadius: '6px 6px 0 50%',
          }}
        />
        <span>
          <strong>Onboarding</strong> — actively being verified · call · docs ·
          agreement · final review
        </span>
      </div>
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="inline-block w-3 h-4 shrink-0 mt-0.5"
          style={{
            backgroundColor: '#E8C547',
            border: '1.5px solid #8A6F1A',
            borderRadius: '6px 6px 0 50%',
          }}
        />
        <span>
          <strong>On the map</strong> — rancher self-submitted or was flagged by a
          fan. Onboarding pending.
        </span>
      </div>
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="inline-block w-3 h-4 shrink-0 mt-0.5"
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
