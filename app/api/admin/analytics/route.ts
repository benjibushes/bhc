import { NextResponse } from 'next/server';
import { getAllRecords } from '@/lib/airtable';
import { TABLES } from '@/lib/airtable';

export async function GET() {
  try {
    // Fetch all data
    const consumers = await getAllRecords(TABLES.CONSUMERS);
    const inquiries = await getAllRecords(TABLES.INQUIRIES);
    const campaigns = await getAllRecords(TABLES.CAMPAIGNS);

    // Calculate overview stats
    const completedSales = inquiries.filter((i: any) => i.fields?.['Status'] === 'Sale Completed');
    const totalSales = completedSales.length;
    const totalRevenue = completedSales.reduce((sum: number, i: any) => {
      return sum + (parseFloat(i.fields?.['Sale Amount'] || '0'));
    }, 0);
    const totalCommission = completedSales.reduce((sum: number, i: any) => {
      return sum + (parseFloat(i.fields?.['Commission Amount'] || '0'));
    }, 0);
    const conversionRate = inquiries.length > 0 ? totalSales / inquiries.length : 0;

    // Calculate campaign performance
    const campaignStats: any[] = [];
    const campaignMap = new Map();

    // Group data by campaign
    campaigns.forEach((c: any) => {
      const name = c.fields?.['Campaign Name'];
      if (name) {
        campaignMap.set(name, {
          campaignName: name,
          emailsSent: parseInt(c.fields?.['Recipients Count'] || '0'),
          signUps: 0,
          inquiries: 0,
          sales: 0,
          totalRevenue: 0,
          totalCommission: 0,
        });
      }
    });

    // Count sign-ups per campaign
    consumers.forEach((c: any) => {
      const campaign = c.fields?.['Campaign'];
      if (campaign && campaignMap.has(campaign)) {
        const stats = campaignMap.get(campaign);
        stats.signUps++;
      }
    });

    // Count inquiries, sales, revenue per campaign
    inquiries.forEach((i: any) => {
      const source = i.fields?.['Source'];
      if (source && campaignMap.has(source)) {
        const stats = campaignMap.get(source);
        stats.inquiries++;
        
        if (i.fields?.['Status'] === 'Sale Completed') {
          stats.sales++;
          stats.totalRevenue += parseFloat(i.fields?.['Sale Amount'] || '0');
          stats.totalCommission += parseFloat(i.fields?.['Commission Amount'] || '0');
        }
      }
    });

    // Convert map to array
    campaignStats.push(...Array.from(campaignMap.values()));

    // Build recent activity feed
    const recentActivity: any[] = [];

    // Add recent sign-ups
    consumers
      .slice(-10)
      .reverse()
      .forEach((c: any) => {
        recentActivity.push({
          type: 'signup',
          name: c.fields?.['Full Name'] || 'Unknown',
          details: `Applied for access in ${c.fields?.['State'] || 'Unknown'}`,
          source: c.fields?.['Campaign'] || c.fields?.['Source'] || 'organic',
          date: c.fields?.['Created'] || new Date().toISOString(),
        });
      });

    // Add recent inquiries
    inquiries
      .filter((i: any) => i.fields?.['Status'] !== 'Pending')
      .slice(-5)
      .reverse()
      .forEach((i: any) => {
        recentActivity.push({
          type: 'inquiry',
          name: i.fields?.['Consumer Name'] || 'Unknown',
          details: `Inquired about ${i.fields?.['Ranch Name'] || 'a ranch'}`,
          source: i.fields?.['Source'] || 'organic',
          date: i.fields?.['Created'] || new Date().toISOString(),
        });
      });

    // Add recent sales
    completedSales
      .slice(-5)
      .reverse()
      .forEach((i: any) => {
        recentActivity.push({
          type: 'sale',
          name: i.fields?.['Consumer Name'] || 'Unknown',
          details: `Purchased from ${i.fields?.['Ranch Name'] || 'a ranch'}`,
          source: i.fields?.['Source'] || 'organic',
          amount: parseFloat(i.fields?.['Commission Amount'] || '0'),
          date: i.fields?.['Created'] || new Date().toISOString(),
        });
      });

    // Sort activity by date
    recentActivity.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return NextResponse.json({
      overview: {
        totalConsumers: consumers.length,
        totalInquiries: inquiries.length,
        totalSales,
        totalRevenue,
        totalCommission,
        conversionRate,
      },
      campaigns: campaignStats,
      recentActivity: recentActivity.slice(0, 20),
    });
  } catch (error: any) {
    console.error('Error fetching analytics:', error);
    return NextResponse.json({ error: error.message || 'Failed to fetch analytics' }, { status: 500 });
  }
}


