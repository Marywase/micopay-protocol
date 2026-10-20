import { useTranslation } from 'react-i18next';
import { AvatarPlaceholder } from '../components/AvatarPlaceholder';
import { Logo } from '../components/Logo';

interface ExploreProps {
    onBack?: () => void;
    onNavigate?: (page: string) => void;
    /** CETES abierto en este build; si no, la tarjeta dice "Próximamente". */
    cetesAvailable?: boolean;
    /** Blend abierto en este build; si no, la tarjeta dice "Próximamente". */
    blendAvailable?: boolean;
}

/** Botón de una tarjeta: el real, o uno deshabilitado que dice "Próximamente". */
function CardAction({ available, onClick, className, label, icon }: {
    available: boolean;
    onClick: () => void;
    className: string;
    label: string;
    icon: string;
}) {
    const { t } = useTranslation();
    if (!available) {
        return (
            <button
                disabled
                aria-disabled="true"
                className="w-full border-2 border-linea text-gris font-bold py-3 px-6 rounded-sm flex items-center justify-center gap-2 cursor-not-allowed">
                {t('comingSoon.badge')}
                <span className="material-symbols-outlined text-sm">schedule</span>
            </button>
        );
    }
    return (
        <button onClick={onClick} className={className}>
            {label}
            <span className="material-symbols-outlined text-sm">{icon}</span>
        </button>
    );
}

const Explore = ({ onBack, onNavigate, cetesAvailable = true, blendAvailable = true }: ExploreProps) => {
    const { t } = useTranslation();
    return (
        <div className="bg-surface text-on-surface font-body min-h-screen flex flex-col pb-32">
            {/* Header */}
            <header className="fixed top-0 left-0 w-full z-50 flex justify-between items-center px-6 py-4 pt-[max(1rem,env(safe-area-inset-top))] bg-papel border-b-2 border-tinta">
                <Logo />
                    {/* Era una foto de stock servida desde lh3.googleusercontent.com.
                        En un APK con cola offline eso es una dependencia de red para
                        pintar el encabezado: sin senal se veia como imagen rota.
                        Glifo local, cero peticiones. */}
                    <div className="w-10 h-10 rounded-sm border-2 border-tinta bg-papel flex items-center justify-center">
                        <span aria-hidden="true" className="material-symbols-outlined text-verde text-xl">person</span>
                        <span className="sr-only">Perfil de usuario</span>
                </div>
            </header>

            <main className="flex-1 mt-[calc(5rem+env(safe-area-inset-top))] px-6">
                <section className="mb-10 pt-4">
                    <h1 className="font-headline font-extrabold text-3xl text-on-surface leading-tight mb-2">
                        {t('exploreScreen.title')}
                    </h1>
                    <p className="text-on-surface-variant font-medium opacity-70 italic">
                        {t('exploreScreen.subtitle')}
                    </p>
                </section>

                <div className="space-y-6">
                    {/* CETES tokenizados: abierto o "Próximamente" (constants/features.ts) */}
                    <article className={`p-6 rounded-sm border border-primary/10 relative overflow-hidden transition-all ${cetesAvailable ? 'group active:translate-x-[2px] active:translate-y-[2px]' : 'opacity-70'}`}>
                        <div className="flex items-center gap-4 mb-4">
                            <div className="w-12 h-12 bg-papel rounded-sm flex items-center justify-center ">
                                <span className="material-symbols-outlined text-primary text-3xl">trending_up</span>
                            </div>
                            <div>
                                <h2 className="font-headline font-bold text-xl text-on-surface">{t('exploreScreen.investCetes')}</h2>
                                <p className="num text-[10px] font-bold text-primary uppercase tracking-widest">{t('exploreScreen.cetesRateBadge', { rate: 5.6 })}</p>
                            </div>
                        </div>
                        <p className="text-sm text-on-surface-variant leading-relaxed mb-6">
                            {t('exploreScreen.cetesDesc')}
                        </p>
                        <CardAction
                            available={cetesAvailable}
                            onClick={() => onNavigate?.('cetes')}
                            className="w-full bg-primary text-papel font-bold py-3 px-6 rounded-sm flex items-center justify-center gap-2 "
                            label={t('exploreScreen.viewCetes')}
                            icon="arrow_forward"
                        />
                    </article>

                    {/* Blend: abierto o "Próximamente" (constants/features.ts) */}
                    <article className={`bg-papel p-6 rounded-sm border-2 border-tinta relative overflow-hidden transition-all ${blendAvailable ? 'group active:translate-x-[2px] active:translate-y-[2px]' : 'opacity-70'}`}>
                        <div className="flex items-center gap-4 mb-4">
                            <div className="w-12 h-12 bg-papel rounded-sm flex items-center justify-center border-2 border-tinta">
                                <span className="material-symbols-outlined text-on-surface text-3xl">account_balance</span>
                            </div>
                            <div>
                                <h2 className="font-headline font-bold text-xl text-on-surface">{t('exploreScreen.requestLoan')}</h2>
                                <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">{t('exploreScreen.blendSubtitle')}</p>
                            </div>
                        </div>
                        <p className="text-sm text-on-surface-variant leading-relaxed mb-6">
                            {t('exploreScreen.blendDesc')}
                        </p>
                        <CardAction
                            available={blendAvailable}
                            onClick={() => onNavigate?.('blend')}
                            className="w-full border-2 border-primary text-primary font-bold py-3 px-6 rounded-sm flex items-center justify-center gap-2"
                            label={t('exploreScreen.viewHowMuch')}
                            icon="info"
                        />
                    </article>
                </div>

                {/* Footer Section */}
                <footer className="mt-12 text-center">
                    <p className="text-xs text-gris font-medium">{t('exploreScreen.poweredBy')}</p>
                </footer>
            </main>
        </div>
    );
};

export default Explore;
