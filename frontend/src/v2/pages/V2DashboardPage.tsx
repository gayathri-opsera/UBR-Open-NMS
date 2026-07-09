import React from 'react';
import { EmptyState } from '../components/common/States';

const PAGE_TITLE = 'V2DashboardPage'.replace('V2', '').replace('Page', '');

export default function V2DashboardPage() {
  return (
    <div className="vf-page">
      <div className="vf-page-header">
        <h1 className="vf-page-title">{PAGE_TITLE}</h1>
      </div>
      <EmptyState
        icon={<span aria-hidden="true">🚧</span>}
        title="${PAGE_TITLE} coming soon"
        description="This V2 page is being implemented. Connect the existing V1 components or build new ones here."
      />
    </div>
  );
}
