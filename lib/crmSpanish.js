// Spanish for the homeowner side of Eagle I CRM.
//
// The starter playbooks' Spanish versions (same steps and timing as the
// English; only the words differ). A contact marked Spanish gets these once
// the company approves the playbook, which covers both languages.
const DEFAULT_ES = {
  new_lead_reply: [
    { subject: 'Gracias por comunicarse con {company}', message: 'Hola {name}:\n\nGracias por comunicarse con {company}. Recibimos su mensaje y alguien de nuestro equipo se pondrá en contacto con usted muy pronto, normalmente el mismo día hábil.\n\nSi tiene dos minutos, cuéntenos un poco sobre su proyecto y escoja un horario para que lo visitemos:\n{qualify_link}\n\nHasta pronto,\n{founder}\n{phone}' },
    { subject: 'Seguimiento de {company}', message: 'Hola {name}:\n\nQuería asegurarme de que pudiéramos hablar sobre su proyecto. ¿Cuándo le queda bien una llamada corta?\n\nPuede responder a este correo o llamar al {phone}.' }
  ],
  site_visit_reminder: [
    { subject: 'Nos vemos el {visit_date}', message: 'Hola {name}:\n\nLe recordamos que lo visitaremos el {visit_date} a las {visit_time} en {address}.\n\nSi necesita cambiar la hora, responda a este correo o llame al {phone}.' }
  ],
  estimate_expiring: [
    { subject: 'Su presupuesto de {company} vence el {expires}', message: 'Hola {name}:\n\nLe avisamos que su presupuesto de {estimate_total} es válido hasta el {expires}. Puede revisarlo y aceptarlo aquí:\n\n{estimate_link}\n\nSi tiene preguntas o quiere cambiar algo, solo responda a este correo.' }
  ],
  invoice_reminder: [
    { subject: 'La factura #{invoice_number} vence el {due_date}', message: 'Hola {name}:\n\nLe recordamos que la factura #{invoice_number} por {invoice_amount} vence el {due_date}. Puede pagarla en línea aquí:\n\n{invoice_link}\n\n¡Gracias!' },
    { subject: 'La factura #{invoice_number} está vencida', message: 'Hola {name}:\n\nSegún nuestros registros, la factura #{invoice_number} por {invoice_amount} sigue pendiente. Puede pagarla en línea aquí:\n\n{invoice_link}\n\nSi ya envió el pago, muchas gracias y no haga caso de este mensaje. ¿Preguntas? Responda aquí o llame al {phone}.' }
  ],
  site_visit_prep: [
    { subject: 'Preparándonos para la visita', message: 'Hola {name}:\n\nGracias por programar una visita con {company}. Para aprovechar bien el tiempo, le ayuda tener:\n\n- Algunas fotos o enlaces de estilos que le gustan\n- Un rango de presupuesto con el que se sienta cómodo\n- A todas las personas que participan en la decisión, si es posible\n\nSi algo cambia, responda aquí o llame al {phone}.' }
  ],
  design_agreement_follow_up: [
    { subject: '¿Tiene preguntas sobre el acuerdo de diseño?', message: 'Hola {name}:\n\nQuería saber si pudo revisar el acuerdo de diseño de {company} y si le surgió alguna pregunta.\n\nCon gusto lo repasamos en una llamada corta. Solo responda aquí o llame al {phone}.' },
    { subject: 'El siguiente paso de su proyecto', message: 'Hola {name}:\n\nCuando esté listo para seguir adelante, al firmar el acuerdo de diseño podemos empezar con los planos y los precios de su proyecto.\n\nSi cambiaron los tiempos o cualquier otra cosa, avíseme. Sin ninguna presión.' }
  ],
  proposal_follow_up: [
    { subject: 'Su propuesta de {company}', message: 'Hola {name}:\n\nQuería confirmar que recibió la propuesta y saber si le surgió alguna pregunta al revisarla.\n\nResponda aquí o llame al {phone} y la repasamos juntos.' },
    { subject: 'Sobre su propuesta', message: 'Hola {name}:\n\nSolo quería saber cómo va con la propuesta. Si algo del alcance o de los números necesita otra revisión, con gusto lo ajustamos.\n\n¿Qué le ayudaría más para tomar su decisión?' },
    { subject: '¿Todavía está planeando su proyecto?', message: 'Hola {name}:\n\nNo quiero llenarle el correo, así que este es mi último mensaje sobre la propuesta por ahora. Si sus planes cambiaron, no hay ningún problema. Si todavía lo está pensando, aquí estamos cuando esté listo.' }
  ],
  welcome_aboard: [
    { subject: 'Bienvenido a {company}', message: 'Hola {name}:\n\nGracias por escoger a {company}. Estamos muy contentos de empezar su proyecto.\n\nEn los próximos días nos comunicaremos para programar una reunión de inicio, donde repasaremos el calendario, quién será su contacto principal y qué esperar cada semana.\n\nLa página de su proyecto tiene un asistente que responde sus preguntas sobre el proyecto en cualquier momento, además del calendario, las fotos y una forma de escribirnos:\n{portal_link}\n\nSi tiene preguntas mientras tanto, responda aquí o llame al {phone}.' }
  ],
  job_complete: [
    { subject: 'Gracias de parte de {company}', message: 'Hola {name}:\n\nGracias otra vez por confiar su hogar a {company}. Fue un gusto trabajar con usted.\n\nSi algo necesita atención mientras se acomoda, responda aquí o llame al {phone} y nos encargamos.' },
    { subject: '¿Cómo va todo?', message: 'Hola {name}:\n\nYa pasó como un mes desde que terminamos, así que quería saber cómo va todo.\n\nSi algún amigo o vecino está pensando en un proyecto, le agradeceríamos mucho la recomendación. Este es su enlace personal para compartir, así sabremos a quién darle las gracias:\n{referral_link}' }
  ],
  review_request: [
    { subject: '¿Nos regala unas palabras sobre {company}?', message: 'Hola {name}:\n\nAhora que lleva una semana disfrutando su espacio terminado, ¿nos regalaría dos minutos para contar cómo le fue? Las reseñas ayudan a otras familias a encontrar un contratista de confianza.\n\n{review_link}\n\nGracias,\n{founder}' }
  ],
  home_care_reminder: [
    { subject: 'Un recordatorio sobre su {item}', message: 'Hola {name}:\n\nYa toca darle un poco de mantenimiento a su {item}:\n{care_note}\n\nTodo sobre su casa, incluidas las garantías y lo que se instaló, está aquí:\n{portal_link}\n\nSi quiere que nosotros nos encarguemos, responda aquí o llame al {phone}.' }
  ],
  warranty_ending: [
    { subject: 'Su garantía con {company} termina el {warranty_end}', message: 'Hola {name}:\n\nLa garantía de su {item} es válida hasta el {warranty_end}. Antes de que termine, con gusto pasamos a revisar todo, sin costo.\n\nResponda con algunos horarios que le funcionen o llame al {phone}.' }
  ],
  lost_check_back: [
    { subject: '¿Todavía piensa en su proyecto?', message: 'Hola {name}:\n\nHa pasado un tiempo desde que hablamos de su proyecto y quería saber cómo va. Si lo está retomando, {company} con gusto le ayuda.\n\nSi no, no hace falta responder. Le deseamos lo mejor.' }
  ]
};

// The words around the emails Eagle I sends the homeowner directly (an
// estimate, an invoice, a change order, a project update). {x} is filled in.
const PHRASES = {
  en: {
    hi: 'Hi {first},', there: 'there',
    est_subject: 'Your {label} from {company}: {title}', est_intro: 'Here is your {label} from {company}: {title}.', est_button: 'View your {label}',
    est_total: 'Total: {total}', est_valid: ' · valid until {date}', est_how: 'You can review it, download a PDF, and accept it online.',
    questions: 'Questions? Just reply to this email{phone}.', or_call: ' or call {phone}', view_here: 'View it here: {link}',
    estimate: 'construction estimate', design_agreement: 'design agreement',
    inv_subject: 'Invoice #{number} from {company}: {amount}', inv_intro: 'Here is invoice #{number} for {title}: {amount}{due}.', inv_due: ', due {date}', inv_button: 'View and pay',
    co_subject: 'Change order #{number} to review: {title}', co_intro: 'There’s a change order for your project to review: {title} ({change}{days}).',
    co_adds: 'adds {amount}', co_credits: 'credits {amount}', co_days: ', {n} more working day{s}', co_link: 'Review and approve it in your project portal',
    upd_subject: 'Project update from {company}: {title}', upd_link: 'See photos and everything about your project'
  },
  es: {
    hi: 'Hola {first}:', there: '',
    est_subject: 'Su {label} de {company}: {title}', est_intro: 'Aquí está su {label} de {company}: {title}.', est_button: 'Ver su {label}',
    est_total: 'Total: {total}', est_valid: ' · válido hasta el {date}', est_how: 'Puede revisarlo, descargar un PDF y aceptarlo en línea.',
    questions: '¿Preguntas? Solo responda a este correo{phone}.', or_call: ' o llame al {phone}', view_here: 'Véalo aquí: {link}',
    estimate: 'presupuesto', design_agreement: 'acuerdo de diseño',
    inv_subject: 'Factura #{number} de {company}: {amount}', inv_intro: 'Aquí está la factura #{number} por {title}: {amount}{due}.', inv_due: ', con vencimiento el {date}', inv_button: 'Ver y pagar',
    co_subject: 'Orden de cambio #{number} para revisar: {title}', co_intro: 'Hay una orden de cambio de su proyecto para revisar: {title} ({change}{days}).',
    co_adds: 'agrega {amount}', co_credits: 'acredita {amount}', co_days: ', {n} día{s} hábil{es} más', co_link: 'Revísela y apruébela en el portal de su proyecto',
    upd_subject: 'Novedades de su proyecto con {company}: {title}', upd_link: 'Vea las fotos y todo sobre su proyecto'
  }
};
function say(lang, key, vars = {}) {
  const t = (PHRASES[lang] || PHRASES.en)[key] ?? PHRASES.en[key] ?? key;
  return t.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? '' : String(vars[k]))).replace(/ +([:,])/g, '$1');
}
const langOf = (v) => (v === 'es' ? 'es' : 'en');
const dateIn = (lang, d, opts) => new Date(d).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', opts);

// What the homeowner's pages can be told, in Spanish (the server's words are
// English; routes under /api/crm-public translate when the page asks for es).
const ERRORS_ES = {
  'This form is no longer active.': 'Este formulario ya no está activo.',
  'Please add your name.': 'Por favor escriba su nombre.',
  'Please add an email or phone number so we can reach you.': 'Por favor escriba un correo o teléfono para comunicarnos con usted.',
  'Please add an email or phone number.': 'Por favor escriba un correo o teléfono.',
  'That email address does not look right.': 'Ese correo electrónico no parece correcto.',
  'Too many requests right now. Please try again later or call us.': 'Demasiadas solicitudes en este momento. Intente más tarde o llámenos.',
  'Too many attempts. Please try again later.': 'Demasiados intentos. Por favor intente más tarde.',
  'This link is not valid.': 'Este enlace no es válido.',
  'Pick at least one kind of project.': 'Escoja al menos un tipo de proyecto.',
  'Pick a budget range (or “Not sure yet”).': 'Escoja un rango de presupuesto (o “Todavía no sé”).',
  'Pick when you’d like to start.': 'Escoja cuándo le gustaría empezar.',
  'Pick a time.': 'Escoja una hora.',
  'That time was just taken. Please pick another.': 'Esa hora se acaba de ocupar. Por favor escoja otra.',
  'This booking page is no longer active.': 'Esta página de citas ya no está activa.',
  'Please contact us directly to set up a visit.': 'Por favor comuníquese con nosotros para programar una visita.',
  'Write a message first.': 'Primero escriba un mensaje.',
  'Choose a file to upload.': 'Escoja un archivo para subir.',
  'That file is too big. The limit is 8 MB.': 'El archivo es demasiado grande. El límite es de 8 MB.',
  'Only photos (JPEG, PNG, WebP) and PDFs can be uploaded.': 'Solo se pueden subir fotos (JPEG, PNG, WebP) y archivos PDF.',
  'This deal already has the most files allowed.': 'Este proyecto ya tiene el máximo de archivos permitido.',
  'Type your full name to approve.': 'Escriba su nombre completo para aprobar.',
  'Type your full name to accept.': 'Escriba su nombre completo para aceptar.',
  'Pick one of the options.': 'Escoja una de las opciones.',
  'You already chose. Message your team if you’d like to change it.': 'Ya escogió. Escriba a su equipo si quiere cambiarlo.',
  'Change order not found.': 'No se encontró la orden de cambio.',
  'Selection not found.': 'No se encontró la selección.',
  'This estimate link is not valid.': 'Este enlace de presupuesto no es válido.',
  'This estimate has expired. Please contact us for an updated one.': 'Este presupuesto venció. Comuníquese con nosotros para uno actualizado.',
  'This estimate is being updated. Please wait for the new version.': 'Este presupuesto se está actualizando. Por favor espere la nueva versión.',
  'This estimate was already accepted.': 'Este presupuesto ya fue aceptado.',
  'This estimate changed while you were viewing it. Please reload.': 'Este presupuesto cambió mientras lo veía. Por favor recargue la página.',
  'This estimate can’t be declined right now.': 'Este presupuesto no se puede rechazar en este momento.',
  'This invoice link is not valid.': 'Este enlace de factura no es válido.',
  'This invoice is already paid. Thank you!': 'Esta factura ya está pagada. ¡Gracias!',
  'This invoice is already paid.': 'Esta factura ya está pagada.',
  'This invoice can’t be paid online.': 'Esta factura no se puede pagar en línea.',
  'Online payment isn’t available for this invoice. Please use the payment details shown.': 'El pago en línea no está disponible para esta factura. Use los datos de pago que aparecen.',
  'Pick a number from 1 to 5.': 'Escoja un número del 1 al 5.',
  'This check-in has closed. Please reach out to the team directly.': 'Esta encuesta ya cerró. Comuníquese directamente con el equipo.',
  'Not found.': 'No se encontró.'
};
const translateError = (lang, message) => (lang === 'es' && ERRORS_ES[message]) || message;

const LANGS = { en: 'English', es: 'Español' };
const isLang = (v) => Object.prototype.hasOwnProperty.call(LANGS, v);

module.exports = { DEFAULT_ES, LANGS, isLang, PHRASES, say, langOf, dateIn, ERRORS_ES, translateError };
