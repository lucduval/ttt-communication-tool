import React, { useState, useEffect, useMemo } from 'react';
import {
    LayoutDashboard,
    Send,
    Users,
    BarChart3,
    FileText,
    Settings,
    Bell,
    Search,
    Filter,
    Plus,
    ChevronRight,
    CheckCircle2,
    AlertCircle,
    Clock,
    MoreVertical,
    Mail,
    MessageSquare,
    ArrowUpRight,
    ArrowDownRight,
    X,
    Smartphone,
    Info
} from 'lucide-react';

// --- Components ---

const Button = ({ children, variant = 'primary', className = '', ...props }) => {
    const variants = {
        primary: 'bg-[#1E3A5F] text-white hover:bg-[#162d4a]',
        secondary: 'bg-white text-[#1E3A5F] border border-[#1E3A5F] hover:bg-gray-50',
        ghost: 'bg-transparent text-gray-500 hover:bg-gray-100',
        danger: 'bg-red-50 text-red-600 hover:bg-red-100 border border-red-200'
    };
    return (
        <button
            className={`px-4 py-2 rounded-md font-medium transition-colors duration-200 flex items-center justify-center gap-2 ${variants[variant]} ${className}`}
            {...props}
        >
            {children}
        </button>
    );
};

const Card = ({ children, title, subtitle, footer, className = '' }) => (
    <div className={`bg-white border border-[#F5F7FA] shadow-sm rounded-lg overflow-hidden ${className}`}>
        {(title || subtitle) && (
            <div className="px-6 py-4 border-b border-gray-100">
                {title && <h3 className="text-lg font-semibold text-[#1E3A5F]">{title}</h3>}
                {subtitle && <p className="text-sm text-gray-500">{subtitle}</p>}
            </div>
        )}
        <div className="p-6">{children}</div>
        {footer && <div className="px-6 py-4 bg-gray-50 border-t border-gray-100">{footer}</div>}
    </div>
);

const Badge = ({ children, status = 'default' }) => {
    const colors = {
        success: 'bg-green-50 text-green-700 border-green-200',
        error: 'bg-red-50 text-red-700 border-red-200',
        warning: 'bg-yellow-50 text-yellow-700 border-yellow-200',
        info: 'bg-blue-50 text-blue-700 border-blue-200',
        default: 'bg-gray-50 text-gray-600 border-gray-200'
    };
    return (
        <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium border ${colors[status]}`}>
            {children}
        </span>
    );
};

// --- App Layout & State ---

export default function App() {
    const [activeTab, setActiveTab] = useState('dashboard');
    const [isSidebarCollapsed, setSidebarCollapsed] = useState(false);

    // Navigation
    const navItems = [
        { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
        { id: 'wizard', label: 'Create Campaign', icon: Plus },
        { id: 'recipients', label: 'CRM Recipients', icon: Users },
        { id: 'monitoring', label: 'Monitoring', icon: BarChart3 },
        { id: 'templates', label: 'Templates', icon: FileText },
    ];

    const renderContent = () => {
        switch (activeTab) {
            case 'dashboard': return <DashboardView onNavigate={setActiveTab} />;
            case 'wizard': return <CampaignWizardView onComplete={() => setActiveTab('monitoring')} />;
            case 'recipients': return <RecipientSelectorView />;
            case 'monitoring': return <MonitoringView />;
            case 'templates': return <TemplateManagerView />;
            default: return <DashboardView />;
        }
    };

    return (
        <div className="flex h-screen bg-[#F5F7FA] text-gray-800 font-sans">
            {/* Sidebar */}
            <aside className={`bg-[#1E3A5F] text-white transition-all duration-300 ${isSidebarCollapsed ? 'w-20' : 'w-64'} flex flex-col`}>
                <div className="p-6 flex items-center gap-3">
                    <div className="w-8 h-8 bg-blue-400 rounded flex items-center justify-center font-bold text-[#1E3A5F]"><Send size={20} /></div>
                    {!isSidebarCollapsed && <span className="font-bold text-xl tracking-tight">TTT Connect</span>}
                </div>

                <nav className="flex-1 px-4 py-4 space-y-2">
                    {navItems.map((item) => (
                        <button
                            key={item.id}
                            onClick={() => setActiveTab(item.id)}
                            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 ${activeTab === item.id ? 'bg-white/10 text-white shadow-inner' : 'text-gray-400 hover:text-white hover:bg-white/5'
                                }`}
                        >
                            <item.icon size={20} />
                            {!isSidebarCollapsed && <span className="font-medium">{item.label}</span>}
                        </button>
                    ))}
                </nav>

                <div className="p-4 border-t border-white/10">
                    <div className="flex items-center gap-3 px-4 py-2 text-gray-400">
                        <Settings size={20} />
                        {!isSidebarCollapsed && <span>Settings</span>}
                    </div>
                </div>
            </aside>

            {/* Main Area */}
            <main className="flex-1 flex flex-col overflow-hidden">
                {/* Top Header */}
                <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-8 z-10">
                    <h2 className="text-xl font-bold text-[#1E3A5F]">
                        {navItems.find(n => n.id === activeTab)?.label}
                    </h2>
                    <div className="flex items-center gap-4">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                            <input
                                type="text"
                                placeholder="Search campaigns..."
                                className="pl-10 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#1E3A5F]/20 w-64"
                            />
                        </div>
                        <button className="p-2 relative text-gray-500 hover:bg-gray-100 rounded-full transition-colors">
                            <Bell size={20} />
                            <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full border-2 border-white"></span>
                        </button>
                        <div className="h-8 w-px bg-gray-200 mx-2"></div>
                        <div className="flex items-center gap-3">
                            <div className="text-right">
                                <p className="text-sm font-semibold text-gray-700">Sarah Jenkins</p>
                                <p className="text-xs text-gray-500 uppercase tracking-wider">Marketing Lead</p>
                            </div>
                            <div className="w-10 h-10 rounded-full bg-gray-200 border border-gray-300 flex items-center justify-center text-[#1E3A5F] font-bold">
                                SJ
                            </div>
                        </div>
                    </div>
                </header>

                {/* Content Area */}
                <section className="flex-1 overflow-y-auto p-8">
                    {renderContent()}
                </section>
            </main>
        </div>
    );
}

// --- View: Dashboard ---

function DashboardView({ onNavigate }) {
    const stats = [
        { label: 'Sent this Month', value: '428,901', trend: '+12.5%', isUp: true },
        { label: 'Avg Delivery Rate', value: '98.2%', trend: '+0.4%', isUp: true },
        { label: 'Unsubscribe Rate', value: '0.08%', trend: '-0.01%', isUp: true },
        { label: 'Campaign Failures', value: '12', trend: '+2', isUp: false },
    ];

    return (
        <div className="space-y-8">
            {/* Quick Action Header */}
            <div className="flex justify-between items-end">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Good morning, Sarah</h1>
                    <p className="text-gray-500">Here's what's happening with your communication campaigns today</p>
                </div>
                <Button onClick={() => onNavigate('wizard')}>
                    <Plus size={18} />
                    New Campaign
                </Button>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {stats.map((s, idx) => (
                    <Card key={idx} className="hover:shadow-md transition-shadow">
                        <div className="flex justify-between items-start">
                            <div>
                                <p className="text-sm text-gray-500 font-medium mb-1">{s.label}</p>
                                <p className="text-2xl font-bold text-[#1E3A5F]">{s.value}</p>
                            </div>
                            <div className={`flex items-center text-xs font-bold px-2 py-1 rounded ${s.isUp ? 'text-green-600 bg-green-50' : 'text-red-600 bg-red-50'}`}>
                                {s.isUp ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                                {s.trend}
                            </div>
                        </div>
                    </Card>
                ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Activity Chart Placeholder */}
                <Card className="lg:col-span-2" title="Delivery Trends" subtitle="Performance over the last 14 days">
                    <div className="h-64 w-full bg-gray-50 rounded flex items-end justify-between px-8 py-4">
                        {[65, 78, 92, 45, 88, 95, 100, 82, 75, 91, 85, 98, 92, 94].map((h, i) => (
                            <div
                                key={i}
                                className="w-8 bg-[#1E3A5F]/10 hover:bg-[#1E3A5F]/30 rounded-t-sm transition-all duration-300 relative group"
                                style={{ height: `${h}%` }}
                            >
                                <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-gray-800 text-white text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity">
                                    {h}%
                                </div>
                            </div>
                        ))}
                    </div>
                    <div className="flex justify-between mt-4 text-xs text-gray-400">
                        <span>Jan 21</span>
                        <span>Today</span>
                    </div>
                </Card>

                {/* Recent Activity */}
                <Card title="Active Campaigns">
                    <div className="space-y-6">
                        {[
                            { name: 'Monthly Statement - Jan', status: 'In Progress', type: 'Email', progress: 85 },
                            { name: 'Fixed Deposit Offer', status: 'Scheduled', type: 'WhatsApp', progress: 0 },
                            { name: 'System Maintenance', status: 'Completed', type: 'Email', progress: 100 },
                        ].map((c, i) => (
                            <div key={i} className="flex flex-col gap-2">
                                <div className="flex justify-between items-start">
                                    <div>
                                        <p className="font-semibold text-sm text-gray-800">{c.name}</p>
                                        <div className="flex items-center gap-2 mt-1">
                                            {c.type === 'Email' ? <Mail size={12} className="text-gray-400" /> : <MessageSquare size={12} className="text-gray-400" />}
                                            <span className="text-xs text-gray-400">{c.type}</span>
                                        </div>
                                    </div>
                                    <Badge status={c.status === 'Completed' ? 'success' : c.status === 'In Progress' ? 'info' : 'default'}>
                                        {c.status}
                                    </Badge>
                                </div>
                                {c.progress > 0 && (
                                    <div className="w-full h-1.5 bg-gray-100 rounded-full mt-2">
                                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${c.progress}%` }}></div>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                    <Button variant="ghost" className="w-full mt-6 text-sm">View All Activity</Button>
                </Card>
            </div>
        </div>
    );
}

// --- View: Campaign Wizard ---

function CampaignWizardView({ onComplete }) {
    const [step, setStep] = useState(1);
    const [formData, setFormData] = useState({
        channel: 'email',
        title: '',
        recipients: 'all_clients',
        template: null,
    });

    const nextStep = () => setStep(s => Math.min(s + 1, 4));
    const prevStep = () => setStep(s => Math.max(s - 1, 1));

    const steps = [
        { id: 1, label: 'Channel Selection' },
        { id: 2, label: 'Recipient Selection' },
        { id: 3, label: 'Compose Message' },
        { id: 4, label: 'Review & Send' },
    ];

    return (
        <div className="max-w-4xl mx-auto">
            {/* Wizard Header */}
            <div className="mb-10">
                <div className="flex items-center justify-between mb-8">
                    {steps.map((s, idx) => (
                        <React.Fragment key={s.id}>
                            <div className="flex items-center gap-3">
                                <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${step >= s.id ? 'bg-[#1E3A5F] text-white shadow-lg shadow-[#1E3A5F]/20' : 'bg-gray-200 text-gray-500'
                                    }`}>
                                    {step > s.id ? <CheckCircle2 size={18} /> : s.id}
                                </div>
                                <span className={`text-sm font-medium ${step >= s.id ? 'text-[#1E3A5F]' : 'text-gray-400'}`}>
                                    {s.label}
                                </span>
                            </div>
                            {idx < steps.length - 1 && (
                                <div className={`flex-1 h-[2px] mx-4 rounded ${step > s.id ? 'bg-[#1E3A5F]' : 'bg-gray-200'}`}></div>
                            )}
                        </React.Fragment>
                    ))}
                </div>
            </div>

            {/* Wizard Body */}
            <Card className="min-h-[500px] flex flex-col">
                <div className="flex-1">
                    {step === 1 && (
                        <div className="space-y-6">
                            <h3 className="text-xl font-bold text-gray-900">Choose your communication channel</h3>
                            <p className="text-gray-500">Select the best way to reach your clients for this campaign.</p>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4">
                                <div
                                    onClick={() => setFormData({ ...formData, channel: 'email' })}
                                    className={`p-6 border-2 rounded-xl cursor-pointer transition-all ${formData.channel === 'email' ? 'border-[#1E3A5F] bg-[#1E3A5F]/5' : 'border-gray-100 hover:border-gray-200'
                                        }`}
                                >
                                    <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-lg flex items-center justify-center mb-4">
                                        <Mail size={24} />
                                    </div>
                                    <h4 className="font-bold text-lg mb-1">Email Campaign</h4>
                                    <p className="text-sm text-gray-500">Rich HTML layouts, no character limits, best for newsletters and official statements.</p>
                                </div>

                                <div
                                    onClick={() => setFormData({ ...formData, channel: 'whatsapp' })}
                                    className={`p-6 border-2 rounded-xl cursor-pointer transition-all ${formData.channel === 'whatsapp' ? 'border-[#1E3A5F] bg-[#1E3A5F]/5' : 'border-gray-100 hover:border-gray-200'
                                        }`}
                                >
                                    <div className="w-12 h-12 bg-green-100 text-green-600 rounded-lg flex items-center justify-center mb-4">
                                        <MessageSquare size={24} />
                                    </div>
                                    <h4 className="font-bold text-lg mb-1">WhatsApp Message</h4>
                                    <p className="text-sm text-gray-500">Instant delivery, higher open rates, best for urgent alerts and quick updates.</p>
                                </div>
                            </div>

                            <div className="pt-6">
                                <label className="block text-sm font-semibold text-gray-700 mb-2">Campaign Internal Title</label>
                                <input
                                    type="text"
                                    placeholder="e.g. Annual Bonus Notification 2024"
                                    className="w-full px-4 py-3 border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-[#1E3A5F]/20"
                                />
                            </div>
                        </div>
                    )}

                    {step === 2 && (
                        <div className="space-y-6">
                            <div className="flex justify-between items-center">
                                <div>
                                    <h3 className="text-xl font-bold text-gray-900">Who should receive this?</h3>
                                    <p className="text-gray-500">Filter and select segments from your enterprise CRM.</p>
                                </div>
                                <div className="bg-blue-50 px-4 py-2 rounded-lg text-[#1E3A5F]">
                                    <span className="text-sm font-medium">Estimated Reach: </span>
                                    <span className="text-xl font-bold">18,420</span>
                                </div>
                            </div>

                            <div className="bg-gray-50 p-6 rounded-lg grid grid-cols-1 md:grid-cols-3 gap-4 border border-gray-100">
                                <div>
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Client Type</label>
                                    <select className="w-full bg-white border border-gray-200 p-2 rounded text-sm outline-none">
                                        <option>All Clients</option>
                                        <option>Premium Banking</option>
                                        <option>Retail Banking</option>
                                        <option>Corporate</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Account Status</label>
                                    <select className="w-full bg-white border border-gray-200 p-2 rounded text-sm outline-none">
                                        <option>Active</option>
                                        <option>Dormant</option>
                                        <option>Restricted</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Region</label>
                                    <select className="w-full bg-white border border-gray-200 p-2 rounded text-sm outline-none">
                                        <option>All Regions</option>
                                        <option>North America</option>
                                        <option>Europe</option>
                                        <option>Asia Pacific</option>
                                    </select>
                                </div>
                            </div>

                            <div className="border border-gray-200 rounded-lg overflow-hidden">
                                <table className="w-full text-left text-sm">
                                    <thead className="bg-gray-50 border-b border-gray-200">
                                        <tr>
                                            <th className="px-4 py-3 font-semibold text-gray-600">Name</th>
                                            <th className="px-4 py-3 font-semibold text-gray-600">Email / Phone</th>
                                            <th className="px-4 py-3 font-semibold text-gray-600">Tier</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {[1, 2, 3, 4, 5].map(i => (
                                            <tr key={i} className="border-b border-gray-50 last:border-0">
                                                <td className="px-4 py-3 text-gray-800">Client Account #{1024 + i}</td>
                                                <td className="px-4 py-3 text-gray-500">****@fin-services.com</td>
                                                <td className="px-4 py-3"><Badge>Gold</Badge></td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                <div className="p-3 text-center bg-gray-50 text-xs text-gray-400">
                                    Showing 5 of 18,420 recipients
                                </div>
                            </div>
                        </div>
                    )}

                    {step === 3 && (
                        <div className="space-y-6">
                            <h3 className="text-xl font-bold text-gray-900">Compose your message</h3>
                            {formData.channel === 'email' ? (
                                <div className="space-y-4">
                                    <div>
                                        <label className="block text-sm font-semibold text-gray-700 mb-1">Subject Line</label>
                                        <input type="text" className="w-full p-2 border border-gray-200 rounded outline-none focus:ring-2 focus:ring-blue-100" placeholder="Enter subject..." />
                                    </div>
                                    <div>
                                        <div className="bg-gray-100 border border-gray-200 rounded-t-lg p-2 flex gap-2">
                                            <div className="h-8 w-8 bg-white border border-gray-200 rounded flex items-center justify-center font-bold">B</div>
                                            <div className="h-8 w-8 bg-white border border-gray-200 rounded flex items-center justify-center italic">I</div>
                                            <div className="h-8 w-px bg-gray-300 mx-1"></div>
                                            <Button variant="secondary" className="px-2 py-0 text-xs h-8">Insert Placeholder</Button>
                                        </div>
                                        <textarea
                                            className="w-full h-48 p-4 border-x border-b border-gray-200 rounded-b-lg outline-none resize-none"
                                            placeholder="Start typing your email content here..."
                                        ></textarea>
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    <div className="p-4 bg-yellow-50 border border-yellow-100 rounded-lg flex gap-3 text-yellow-800 text-sm">
                                        <Info size={18} className="shrink-0" />
                                        <p>WhatsApp messages must use pre-approved templates. Select a template to proceed.</p>
                                    </div>
                                    <div className="grid grid-cols-2 gap-4">
                                        <Card className="border-blue-200 bg-blue-50/20">
                                            <h4 className="font-bold text-[#1E3A5F] mb-2">Statement Alert</h4>
                                            <p className="text-xs text-gray-500 mb-4">"Hello {'{{name}}'}, your monthly statement for {'{{month}}'} is now available in the portal."</p>
                                            <Button variant="primary" className="text-xs py-1 px-3">Select Template</Button>
                                        </Card>
                                        <Card>
                                            <h4 className="font-bold text-gray-800 mb-2">Security Login</h4>
                                            <p className="text-xs text-gray-500 mb-4">"Security Alert: A new login was detected on your account at {'{{time}}'} from {'{{location}}'}."</p>
                                            <Button variant="secondary" className="text-xs py-1 px-3">Select Template</Button>
                                        </Card>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {step === 4 && (
                        <div className="space-y-6">
                            <h3 className="text-xl font-bold text-gray-900">Final Review</h3>
                            <div className="bg-gray-50 rounded-xl p-8 border border-gray-100 space-y-6">
                                <div className="grid grid-cols-2 gap-8">
                                    <div>
                                        <label className="text-xs font-bold text-gray-400 uppercase">Channel</label>
                                        <p className="text-lg font-bold text-[#1E3A5F] capitalize">{formData.channel}</p>
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold text-gray-400 uppercase">Recipients</label>
                                        <p className="text-lg font-bold text-[#1E3A5F]">18,420 Clients</p>
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold text-gray-400 uppercase">Estimated Credits</label>
                                        <p className="text-lg font-bold text-[#1E3A5F]">18,420</p>
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold text-gray-400 uppercase">Estimated Time</label>
                                        <p className="text-lg font-bold text-[#1E3A5F]">~12 Minutes</p>
                                    </div>
                                </div>

                                <div className="pt-6 border-t border-gray-200">
                                    <label className="text-xs font-bold text-gray-400 uppercase block mb-4">Message Preview</label>
                                    <div className="bg-white p-6 border border-gray-200 rounded-lg shadow-sm max-h-40 overflow-y-auto italic text-gray-600">
                                        "Hello Jane Doe, your monthly statement for January is now available..."
                                    </div>
                                </div>
                            </div>

                            <div className="flex items-center gap-3 p-4 bg-blue-50 rounded-lg border border-blue-100">
                                <Clock className="text-blue-600" size={20} />
                                <p className="text-sm text-blue-900">Scheduled for Immediate Dispatch</p>
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex justify-between items-center pt-8">
                    <Button
                        variant="ghost"
                        onClick={prevStep}
                        className={step === 1 ? 'invisible' : ''}
                    >
                        Back
                    </Button>

                    <div className="flex gap-3">
                        <Button variant="secondary">Save Draft</Button>
                        <Button onClick={step === 4 ? onComplete : nextStep}>
                            {step === 4 ? 'Confirm & Send Campaign' : 'Continue to Next Step'}
                            <ChevronRight size={18} />
                        </Button>
                    </div>
                </div>
            </Card>
        </div>
    );
}

// --- View: Monitoring ---

function MonitoringView() {
    const [activeCampaign, setActiveCampaign] = useState(0);

    const campaigns = [
        { id: 1, name: 'Statement_Jan_2024', status: 'In Progress', channel: 'Email', total: 18420, sent: 15200, delivered: 14800, failed: 20 },
        { id: 2, name: 'Offer_Premium_Gold', status: 'Completed', channel: 'WhatsApp', total: 5000, sent: 5000, delivered: 4950, failed: 50 },
        { id: 3, name: 'Security_Update_Prod', status: 'Queued', channel: 'Email', total: 42000, sent: 0, delivered: 0, failed: 0 },
    ];

    const current = campaigns[activeCampaign];
    const progressPercent = Math.round((current.sent / current.total) * 100);

    return (
        <div className="space-y-8">
            <div className="flex justify-between items-center">
                <h3 className="text-xl font-bold">Campaign Real-time Monitor</h3>
                <div className="flex items-center gap-2">
                    <span className="flex w-3 h-3 rounded-full bg-green-500 animate-pulse"></span>
                    <span className="text-sm font-medium text-gray-500">System Live</span>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                <Card className="lg:col-span-1" title="Active Sessions">
                    <div className="space-y-3">
                        {campaigns.map((c, idx) => (
                            <div
                                key={c.id}
                                onClick={() => setActiveCampaign(idx)}
                                className={`p-3 rounded-lg border cursor-pointer transition-all ${activeCampaign === idx ? 'border-blue-400 bg-blue-50' : 'border-gray-100 hover:border-gray-200'
                                    }`}
                            >
                                <p className="font-bold text-sm text-[#1E3A5F] truncate">{c.name}</p>
                                <div className="flex justify-between items-center mt-2">
                                    <span className="text-xs text-gray-400">{c.channel}</span>
                                    <Badge status={c.status === 'In Progress' ? 'info' : c.status === 'Completed' ? 'success' : 'default'}>
                                        {c.status}
                                    </Badge>
                                </div>
                            </div>
                        ))}
                    </div>
                </Card>

                <Card className="lg:col-span-3" title={`Monitoring: ${current.name}`} subtitle={`${current.channel} Campaign • Launched Today 09:15 AM`}>
                    <div className="space-y-8">
                        {/* Progress Bar */}
                        <div>
                            <div className="flex justify-between items-center mb-2">
                                <span className="text-sm font-bold text-gray-700">Dispatch Progress</span>
                                <span className="text-sm font-bold text-[#1E3A5F]">{progressPercent}%</span>
                            </div>
                            <div className="h-4 w-full bg-gray-100 rounded-full overflow-hidden">
                                <div className="h-full bg-[#1E3A5F] transition-all duration-500" style={{ width: `${progressPercent}%` }}></div>
                            </div>
                        </div>

                        {/* Status Grid */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div className="p-4 bg-gray-50 rounded-lg border border-gray-100">
                                <p className="text-xs font-bold text-gray-400 uppercase mb-1">Pending</p>
                                <p className="text-xl font-bold text-gray-700">{current.total - current.sent}</p>
                            </div>
                            <div className="p-4 bg-blue-50 rounded-lg border border-blue-100">
                                <p className="text-xs font-bold text-blue-400 uppercase mb-1">Sent</p>
                                <p className="text-xl font-bold text-blue-700">{current.sent}</p>
                            </div>
                            <div className="p-4 bg-green-50 rounded-lg border border-green-100">
                                <p className="text-xs font-bold text-green-400 uppercase mb-1">Delivered</p>
                                <p className="text-xl font-bold text-green-700">{current.delivered}</p>
                            </div>
                            <div className="p-4 bg-red-50 rounded-lg border border-red-100">
                                <p className="text-xs font-bold text-red-400 uppercase mb-1">Failed</p>
                                <p className="text-xl font-bold text-red-700">{current.failed}</p>
                            </div>
                        </div>

                        {/* Error Log */}
                        <div>
                            <h4 className="font-bold text-sm text-gray-700 mb-3 flex items-center gap-2">
                                <AlertCircle size={16} className="text-red-500" />
                                Failure Log (Last 5)
                            </h4>
                            <div className="bg-white border border-gray-100 rounded overflow-hidden">
                                <table className="w-full text-left text-xs">
                                    <thead className="bg-gray-50 text-gray-500 border-b">
                                        <tr>
                                            <th className="px-3 py-2">Recipient</th>
                                            <th className="px-3 py-2">Timestamp</th>
                                            <th className="px-3 py-2">Reason</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-50">
                                        <tr><td className="px-3 py-2">+44 791...</td><td className="px-3 py-2">10:45:12</td><td className="px-3 py-2 text-red-600">Invalid phone number</td></tr>
                                        <tr><td className="px-3 py-2">+44 792...</td><td className="px-3 py-2">10:45:01</td><td className="px-3 py-2 text-red-600">Provider Timeout</td></tr>
                                        <tr><td className="px-3 py-2">user_99@...</td><td className="px-3 py-2">10:44:55</td><td className="px-3 py-2 text-red-600">Bounce - Hard</td></tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </Card>
            </div>
        </div>
    );
}

// --- View: Recipient Selector ---

function RecipientSelectorView() {
    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">CRM Contacts</h1>
                    <p className="text-gray-500">Manage your segmented client lists for mass outreach.</p>
                </div>
                <div className="flex gap-2">
                    <Button variant="secondary"><Plus size={16} /> Import CSV</Button>
                    <Button>Create Segment</Button>
                </div>
            </div>

            <Card>
                <div className="flex flex-col md:flex-row gap-4 mb-6">
                    <div className="flex-1 relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                        <input
                            type="text"
                            placeholder="Filter by name, ID or email..."
                            className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-md text-sm outline-none focus:ring-2 focus:ring-[#1E3A5F]/10"
                        />
                    </div>
                    <div className="flex gap-2">
                        <Button variant="secondary" className="px-3 text-sm py-1"><Filter size={16} /> Filters</Button>
                        <div className="h-8 w-px bg-gray-200 mx-1 self-center"></div>
                        <p className="text-sm font-bold text-[#1E3A5F] self-center">212,045 Records</p>
                    </div>
                </div>

                <div className="border border-gray-100 rounded-lg">
                    <table className="w-full text-left text-sm">
                        <thead className="bg-[#F5F7FA] border-b border-gray-200 text-[#1E3A5F] font-bold">
                            <tr>
                                <th className="px-6 py-4"><input type="checkbox" /></th>
                                <th className="px-6 py-4">Client Name</th>
                                <th className="px-6 py-4">Account Type</th>
                                <th className="px-6 py-4">Last Interaction</th>
                                <th className="px-6 py-4">Compliance Status</th>
                                <th className="px-6 py-4"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {[
                                { name: 'Acme Corp Solutions', type: 'Corporate', last: '2 days ago', status: 'Approved' },
                                { name: 'Dr. Elizabeth Swan', type: 'Premium', last: '5 days ago', status: 'Pending Review' },
                                { name: 'Jonathan Arbuckle', type: 'Retail', last: '1 month ago', status: 'Approved' },
                                { name: 'Venture Ventures LLC', type: 'Corporate', last: '12 hours ago', status: 'Approved' },
                                { name: 'Marcus Aurelius', type: 'Private Banking', last: '3 weeks ago', status: 'Flagged' },
                            ].map((row, i) => (
                                <tr key={i} className="hover:bg-gray-50 transition-colors">
                                    <td className="px-6 py-4"><input type="checkbox" /></td>
                                    <td className="px-6 py-4 font-medium">{row.name}</td>
                                    <td className="px-6 py-4 text-gray-500">{row.type}</td>
                                    <td className="px-6 py-4 text-gray-500">{row.last}</td>
                                    <td className="px-6 py-4">
                                        <Badge status={row.status === 'Approved' ? 'success' : row.status === 'Flagged' ? 'error' : 'warning'}>
                                            {row.status}
                                        </Badge>
                                    </td>
                                    <td className="px-6 py-4 text-right"><MoreVertical size={16} className="text-gray-400 inline cursor-pointer" /></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <div className="p-4 flex justify-between items-center bg-gray-50">
                        <span className="text-xs text-gray-400">Showing page 1 of 4,240</span>
                        <div className="flex gap-1">
                            {[1, 2, 3, '...', 4240].map((p, i) => (
                                <button key={i} className={`w-8 h-8 rounded border text-xs font-bold ${p === 1 ? 'bg-[#1E3A5F] text-white border-[#1E3A5F]' : 'bg-white text-gray-500 border-gray-200'}`}>
                                    {p}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </Card>
        </div>
    );
}

// --- View: Template Manager ---

function TemplateManagerView() {
    const [selectedTemplate, setSelectedTemplate] = useState(null);

    return (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-1 space-y-4">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-xl font-bold">Templates</h3>
                    <Button variant="secondary" className="p-2"><Plus size={18} /></Button>
                </div>

                <div className="relative mb-6">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                    <input type="text" placeholder="Search templates..." className="w-full pl-10 py-2 border border-gray-200 rounded text-sm" />
                </div>

                <div className="space-y-2">
                    {['OTP_Security', 'Balance_Alert', 'Marketing_Offer_Q1', 'System_Downtime', 'Statement_Ready'].map((t, i) => (
                        <div
                            key={i}
                            onClick={() => setSelectedTemplate(t)}
                            className={`p-4 border rounded-lg cursor-pointer flex justify-between items-center ${selectedTemplate === t ? 'bg-[#1E3A5F] text-white' : 'bg-white text-gray-700 hover:border-gray-300'
                                }`}
                        >
                            <div className="flex items-center gap-3">
                                <FileText size={18} />
                                <span className="font-medium text-sm">{t}</span>
                            </div>
                            <Badge status={i % 2 === 0 ? 'success' : 'info'}>Live</Badge>
                        </div>
                    ))}
                </div>
            </div>

            <Card className="lg:col-span-2" title={selectedTemplate || 'Template Editor'} subtitle="Create dynamic templates with variable placeholders">
                {!selectedTemplate ? (
                    <div className="h-96 flex flex-col items-center justify-center text-gray-400">
                        <FileText size={48} className="mb-4 opacity-20" />
                        <p>Select a template to view or edit</p>
                    </div>
                ) : (
                    <div className="space-y-6">
                        <div className="flex gap-4">
                            <div className="flex-1">
                                <label className="text-xs font-bold text-gray-400 uppercase block mb-1">Name</label>
                                <input type="text" value={selectedTemplate} className="w-full p-2 border rounded font-medium" />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-400 uppercase block mb-1">Type</label>
                                <div className="flex items-center gap-2 h-10 px-4 bg-gray-50 border rounded text-sm">
                                    <Smartphone size={16} /> WhatsApp
                                </div>
                            </div>
                        </div>

                        <div>
                            <div className="flex justify-between items-end mb-1">
                                <label className="text-xs font-bold text-gray-400 uppercase">Message Content</label>
                                <span className="text-[10px] text-gray-400">Max 1024 chars</span>
                            </div>
                            <div className="border border-gray-200 rounded-lg overflow-hidden">
                                <div className="bg-gray-50 p-2 flex gap-2 border-b">
                                    <button className="px-2 py-1 text-xs font-bold bg-white border rounded">{'{{First_Name}}'}</button>
                                    <button className="px-2 py-1 text-xs font-bold bg-white border rounded">{'{{Account_Last_4}}'}</button>
                                    <button className="px-2 py-1 text-xs font-bold bg-white border rounded">{'{{Amount}}'}</button>
                                </div>
                                <textarea
                                    className="w-full h-40 p-4 outline-none resize-none font-mono text-sm"
                                    defaultValue={`Hello {{First_Name}}, this is an automated alert from FinBank. Your account ending in {{Account_Last_4}} has been debited by {{Amount}} for a recent transaction. If this wasn't you, please call us immediately.`}
                                ></textarea>
                            </div>
                        </div>

                        <div className="bg-blue-50/50 p-4 rounded-lg border border-blue-100">
                            <h4 className="text-sm font-bold text-blue-800 mb-2 flex items-center gap-2">
                                <CheckCircle2 size={16} /> Meta Verification Status
                            </h4>
                            <p className="text-xs text-blue-700">This template is currently <strong>Approved</strong>. Changes will require re-verification (typically 1-2 hours).</p>
                        </div>

                        <div className="flex justify-end gap-3 pt-4 border-t">
                            <Button variant="ghost">Archive Template</Button>
                            <Button variant="secondary">Discard Changes</Button>
                            <Button>Save & Re-submit</Button>
                        </div>
                    </div>
                )}
            </Card>
        </div>
    );
}