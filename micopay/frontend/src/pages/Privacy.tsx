interface PrivacyProps {
  onBack: () => void;
}

const Privacy = ({ onBack }: PrivacyProps) => {
  return (
    <div className="bg-fondo text-tinta min-h-screen flex flex-col pb-10">
      <header className="fixed top-0 left-0 w-full z-50 flex items-center gap-4 px-4 py-4 pt-[max(1rem,env(safe-area-inset-top))] bg-papel border-b-2 border-tinta/60">
        <button
          onClick={onBack}
          className="min-h-12 min-w-12 flex items-center justify-center rounded-sm hover:bg-[#EFF6FA] transition-colors"
          aria-label="Regresar"
        >
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <div>
          <h1 className="font-bold text-lg leading-tight">Política de Privacidad</h1>
          <p className="text-[11px] text-gris">Última actualización: octubre 2026</p>
        </div>
      </header>

      <main className="flex-1 mt-[calc(5rem+env(safe-area-inset-top))] px-4 pt-4 space-y-5 max-w-lg mx-auto w-full">
        <div className="bg-amber-50 border border-amber-200 rounded-sm px-4 py-3 flex items-start gap-3">
          <span className="material-symbols-outlined text-amber-600 mt-0.5 text-lg">info</span>
          <p className="text-sm text-amber-800 font-medium">
            BORRADOR — Pendiente de revisión legal. No constituye asesoramiento jurídico.
          </p>
        </div>

        <section className="bg-papel rounded-sm p-5 border-2 border-tinta/60 space-y-4">
          <h2 className="font-bold text-base text-tinta">1. Información que recopilamos</h2>
          <p className="text-sm text-gris leading-relaxed">
            Recopilamos la información necesaria para operar el servicio: tu nombre de usuario,
            tu dirección pública de Stellar y el historial de transacciones asociado a tu cuenta.
          </p>
          <p className="text-sm text-gris leading-relaxed">
            <strong>Verificación de identidad.</strong> Para operar efectivo↔cripto la ley nos obliga a
            identificarte. Esa verificación la hace por cuenta de MicoPay nuestro proveedor Didit, en su
            propia página: ahí capturas tu identificación oficial (INE o pasaporte) y una selfie, y Didit
            puede validar tu CURP. La selfie y la comparación de tu rostro son <strong>datos biométricos,
            que la ley considera datos personales sensibles</strong>, y solo se tratan con tu consentimiento
            expreso, que das al iniciar la verificación.
          </p>
          <p className="text-sm text-gris leading-relaxed">
            MicoPay no guarda tus documentos, tu selfie ni tu CURP en sus servidores. Solo guardamos el
            resultado: si fuiste aprobado o rechazado, el nivel de verificación, la fecha y, en caso de
            rechazo, un código del motivo (por ejemplo, documento vencido).
          </p>
        </section>

        <section className="bg-papel rounded-sm p-5 border-2 border-tinta/60 space-y-4">
          <h2 className="font-bold text-base text-tinta">2. Cómo usamos tu información</h2>
          <p className="text-sm text-gris leading-relaxed">
            Usamos tu información exclusivamente para:
          </p>
          <ul className="text-sm text-gris leading-relaxed list-disc pl-5 space-y-1">
            <li>Procesar y verificar transacciones P2P</li>
            <li>Mostrar tu historial de operaciones</li>
            <li>Prevenir fraudes y operaciones duplicadas</li>
            <li>Cumplir con obligaciones legales aplicables</li>
          </ul>
        </section>

        <section className="bg-papel rounded-sm p-5 border-2 border-tinta/60 space-y-4">
          <h2 className="font-bold text-base text-tinta">3. Compartir datos con terceros</h2>
          <p className="text-sm text-gris leading-relaxed">
            No vendemos ni compartimos tu información personal con terceros con fines comerciales.
            Las transacciones se registran en la red pública de Stellar, lo cual es inherente al
            funcionamiento de la cadena de bloques.
          </p>
          <p className="text-sm text-gris leading-relaxed">
            Trabajamos con estos proveedores, que tratan tus datos solo para prestarnos el servicio:
          </p>
          <ul className="text-sm text-gris leading-relaxed list-disc pl-5 space-y-1">
            <li><strong>Didit:</strong> verificación de identidad (documento, selfie, CURP).</li>
            <li><strong>Etherfuse:</strong> solo si usas CETES o SPEI; hace su propia verificación y recibe tu correo.</li>
          </ul>
        </section>

        <section className="bg-papel rounded-sm p-5 border-2 border-tinta/60 space-y-4">
          <h2 className="font-bold text-base text-tinta">4. Seguridad</h2>
          <p className="text-sm text-gris leading-relaxed">
            Implementamos medidas técnicas razonables para proteger tu información, incluyendo
            cifrado en tránsito (HTTPS) y en reposo para datos sensibles. Sin embargo, ningún
            sistema es 100% seguro.
          </p>
        </section>

        <section className="bg-papel rounded-sm p-5 border-2 border-tinta/60 space-y-4">
          <h2 className="font-bold text-base text-tinta">5. Tus derechos y eliminación de datos</h2>
          <p className="text-sm text-gris leading-relaxed">
            Puedes solicitar la eliminación de tu cuenta directamente desde la sección de Perfil de la app. 
            Nuestra política de eliminación de datos garantiza la máxima minimización de datos personales (PII):
          </p>
          <ul className="text-sm text-gris leading-relaxed list-disc pl-5 space-y-2">
            <li><strong>Anonimización de perfil:</strong> Tu nombre de usuario, dirección pública de Stellar y hash de teléfono se eliminan de forma permanente y se reemplazan por representaciones totalmente anónimas y no rastreables.</li>
            <li><strong>Eliminación completa:</strong> Tu registro de billetera (wallet) y todos los tokens de notificaciones push (FCM) se eliminan por completo de nuestra base de datos.</li>
            <li><strong>Mensajes y disputas:</strong> Tus mensajes de chat se eliminan por completo, y los detalles o evidencias en disputas reportadas se purgan de datos identificables.</li>
            <li><strong>Integridad financiera:</strong> Para cumplir con normativas de seguridad e integridad de la plataforma, el historial de transacciones (trades) y los hashes de transacciones públicas en el ledger de Stellar se conservan únicamente vinculados a tu perfil ya anonimizado.</li>
          </ul>
          <p className="text-sm text-gris leading-relaxed">
            Para dudas sobre el proceso o para ejercer otros derechos ARCO, contáctanos en <a href="mailto:privacidad@micopay.app" className="text-primary hover:underline">privacidad@micopay.app</a>.
          </p>
        </section>

        <section className="bg-papel rounded-sm p-5 border-2 border-tinta/60 space-y-4">
          <h2 className="font-bold text-base text-tinta">6. Cambios a esta política</h2>
          <p className="text-sm text-gris leading-relaxed">
            Notificaremos cambios relevantes a través de la app. El uso continuo del servicio
            implica aceptación de la política vigente.
          </p>
        </section>
      </main>
    </div>
  );
};

export default Privacy;
