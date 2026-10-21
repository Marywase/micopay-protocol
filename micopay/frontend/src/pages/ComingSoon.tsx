import { useTranslation } from 'react-i18next';

interface ComingSoonProps {
  /** Titulo de la funcion, ya traducido (p. ej. "Invierte en CETES"). */
  title: string;
  icon: string;
  onBack: () => void;
}

/**
 * Lo que se ve al entrar a una funcion que aun no esta abierta en este build
 * (ver constants/features.ts). Cubre la entrada por URL, por la barra inferior
 * o por el regreso del KYC: ninguna abre la pantalla real.
 */
const ComingSoon = ({ title, icon, onBack }: ComingSoonProps) => {
  const { t } = useTranslation();
  return (
    <div className="bg-surface text-on-surface font-body min-h-screen flex flex-col items-center justify-center px-6 pb-32 text-center">
      <div className="w-16 h-16 bg-papel rounded-sm border-2 border-tinta flex items-center justify-center mb-6">
        <span aria-hidden="true" className="material-symbols-outlined text-primary text-4xl">{icon}</span>
      </div>
      <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-primary mb-2">{t('comingSoon.badge')}</p>
      <h1 className="font-headline font-extrabold text-2xl mb-3">{title}</h1>
      <p className="text-sm text-on-surface-variant leading-relaxed max-w-xs mb-8">{t('comingSoon.desc')}</p>
      <button
        onClick={onBack}
        className="min-h-12 border-2 border-tinta bg-papel text-tinta font-bold py-3 px-6 rounded-sm active:translate-x-[2px] active:translate-y-[2px]"
      >
        {t('comingSoon.back')}
      </button>
    </div>
  );
};

export default ComingSoon;
