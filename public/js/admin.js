const loginPanel = document.querySelector("#admin-login");
const dashboard = document.querySelector("#admin-dashboard");
const loginForm = document.querySelector("#admin-login-form");
const loginFeedback = document.querySelector("#login-feedback");
const registerCustomerForm = document.querySelector("#register-customer-form");
const registerCustomerFeedback = document.querySelector("#register-customer-feedback");
const customerPlansFeedback = document.querySelector("#customer-plans-feedback");
const customerAccessForm = document.querySelector("#customer-access-form");
const customerAccessFeedback = document.querySelector("#customer-access-feedback");
const customersList = document.querySelector("#customers-list");
const customersFeedback = document.querySelector("#customers-feedback");
const emptyCustomers = document.querySelector("#empty-customers");
const customerSearchInput = document.querySelector("#customer-search");
const editCustomerForm = document.querySelector("#edit-customer-form");
const registrationDateInput = registerCustomerForm.elements.registrationDate;
const detailFeedback = document.querySelector("#detail-feedback");
const monthlyPaymentList = document.querySelector("#monthly-payments-list");
const emptyMonthlyPayments = document.querySelector("#empty-monthly-payments");
const monthlyPaymentsFeedback = document.querySelector("#monthly-payments-feedback");
const paymentDetail = document.querySelector("#payment-detail");
const paymentData = document.querySelector("#payment-data");
const receiptPreview = document.querySelector("#receipt-preview");
const approveButton = document.querySelector("#approve-payment");
const monthlyPaymentFilter = document.querySelector("#monthly-payment-filter");
const membershipsFeedback = document.querySelector("#memberships-feedback");
const membershipsList = document.querySelector("#memberships-list");
const emptyMemberships = document.querySelector("#empty-memberships");
const planForm = document.querySelector("#plan-form");
const plansList = document.querySelector("#plans-list");
const plansFeedback = document.querySelector("#plans-feedback");
const emptyPlans = document.querySelector("#empty-plans");
const resetPlanFormButton = document.querySelector("#reset-plan-form");
const paymentSettingsForm = document.querySelector("#payment-settings-form");
const paymentSettingsFeedback = document.querySelector("#payment-settings-feedback");
let adminToken = localStorage.getItem("adminToken");
let selectedPaymentId = null;
let selectedPaymentType = "enrollment";
let memberships = [];
let plans = [];
let registeredCustomers = [];

function localDateValue(date = new Date()) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function formatDueDate(value) {
	const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
	return new Intl.DateTimeFormat("es-VE", {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	}).format(new Date(Date.UTC(year, month - 1, day)));
}

function showFeedback(element, message, kind = "") {
	element.textContent = message;
	if (kind) element.dataset.kind = kind;
	else element.removeAttribute("data-kind");
}

async function adminRequest(path, options = {}) {
	const headers = new Headers(options.headers || {});
	if (adminToken) headers.set("Authorization", `Bearer ${adminToken}`);
	if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");

	const method = String(options.method || "GET").toUpperCase();
	const maxAttempts = method === "GET" ? 3 : 1;
	let response;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			response = await fetch(path, { ...options, headers });
			if (![502, 503].includes(response.status) || attempt === maxAttempts) break;
		} catch (error) {
			if (!(error instanceof TypeError) || attempt === maxAttempts) {
				if (error instanceof TypeError) {
					throw new Error("No se pudo conectar con el servidor. Verifica tu conexión e inténtalo de nuevo.");
				}
				throw error;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
	}

	const text = await response.text();
	let data = null;
	if (text) {
		try { data = JSON.parse(text); }
		catch { data = { error: text }; }
	}

	if (response.status === 401 && path !== "/api/admin/login") {
		signOut();
		throw new Error("La sesión administrativa venció. Inicia sesión de nuevo.");
	}
	if (!response.ok) throw new Error(data?.error || `Error HTTP ${response.status}`);
	return data;
}

function showDashboard() {
	loginPanel.hidden = true;
	dashboard.hidden = false;
	loadMonthlyPayments();
	loadMemberships();
	loadCustomers();
	loadPlans();
	loadPaymentSettings();
}

function signOut() {
	adminToken = null;
	selectedPaymentId = null;
	selectedPaymentType = "enrollment";
	localStorage.removeItem("adminToken");
	dashboard.hidden = true;
	loginPanel.hidden = false;
	paymentDetail.hidden = true;
	loginForm.reset();
}

function appendDetail(label, value) {
	const term = document.createElement("dt");
	term.textContent = label;
	const description = document.createElement("dd");
	description.textContent = value;
	paymentData.append(term, description);
}

function resetPlanForm() {
	planForm.reset();
	planForm.elements.planId.value = "";
	planForm.elements.image.required = true;
	planForm.querySelector('button[type="submit"]').textContent = "Agregar plan";
	resetPlanFormButton.hidden = true;
}

function renderPlanRow(plan) {
	const row = document.createElement("tr");
	const imageCell = document.createElement("td");
	const image = document.createElement("img");
	image.className = "plan-thumbnail";
	image.src = plan.imageUrl;
	image.alt = `Imagen de ${plan.name}`;
	image.loading = "lazy";
	imageCell.append(image);

	const nameCell = document.createElement("td");
	nameCell.textContent = plan.name;
	const enrollmentCell = document.createElement("td");
	enrollmentCell.textContent = `$${Number(plan.enrollmentFee).toFixed(2)} USD`;
	const membershipCell = document.createElement("td");
	membershipCell.textContent = `$${Number(plan.membershipFee).toFixed(2)} USD`;
	const periodCell = document.createElement("td");
	periodCell.textContent = plan.period;
	const actionCell = document.createElement("td");
	const editButton = document.createElement("button");
	editButton.className = "view-payment";
	editButton.type = "button";
	editButton.textContent = "Editar";
	editButton.addEventListener("click", () => {
		planForm.elements.planId.value = plan.id;
		planForm.elements.name.value = plan.name;
		planForm.elements.description.value = plan.description || "";
		planForm.elements.benefits.value = (plan.benefits || []).join("\n");
		planForm.elements.enrollmentFee.value = Number(plan.enrollmentFee).toFixed(2);
		planForm.elements.membershipFee.value = Number(plan.membershipFee).toFixed(2);
		planForm.elements.period.value = plan.period;
		planForm.elements.image.value = "";
		planForm.elements.image.required = false;
		planForm.querySelector('button[type="submit"]').textContent = "Guardar cambios";
		resetPlanFormButton.hidden = false;
		planForm.scrollIntoView({ behavior: "smooth", block: "center" });
		planForm.elements.name.focus({ preventScroll: true });
	});

	const deleteButton = document.createElement("button");
	deleteButton.className = "delete-plan-button";
	deleteButton.type = "button";
	deleteButton.textContent = "Eliminar";
	deleteButton.addEventListener("click", async () => {
		if (!window.confirm(`¿Eliminar el plan "${plan.name}"? Dejará de aparecer en el menú de clientes.`)) return;
		deleteButton.disabled = true;
		showFeedback(plansFeedback, `Eliminando ${plan.name}...`);
		try {
			const data = await adminRequest(`/api/admin/plans/${encodeURIComponent(plan.id)}`, {
				method: "DELETE",
			});
			await loadPlans();
			showFeedback(plansFeedback, data.message);
		} catch (error) {
			showFeedback(plansFeedback, error.message || "No se pudo eliminar el plan.", "error");
		} finally {
			deleteButton.disabled = false;
		}
	});
	actionCell.append(editButton, deleteButton);
	row.append(imageCell, nameCell, enrollmentCell, membershipCell, periodCell, actionCell);
	return row;
}

function updateCustomerEnrollmentAmount() {
	const selectedOption = registerCustomerForm.elements.planName.selectedOptions[0];
	const enrollmentAmount = selectedOption?.dataset.enrollmentFee;
	registerCustomerForm.elements.enrollmentAmount.value = enrollmentAmount === undefined
		? ""
		: Number(enrollmentAmount).toFixed(2);
}

async function loadPlans() {
	showFeedback(plansFeedback, "Cargando planes...");
	try {
		const data = await adminRequest("/api/admin/plans");
		plans = data.plans;
		plansList.replaceChildren(...plans.map(renderPlanRow));
		emptyPlans.hidden = plans.length !== 0;

		const customerPlanSelect = registerCustomerForm.elements.planName;
		const selectedCustomerPlan = customerPlanSelect.value;
		customerPlanSelect.replaceChildren(new Option("Selecciona un plan", ""));
		plans.forEach((plan) => {
			const customerOption = new Option(
				`${plan.name} · $${Number(plan.membershipFee).toFixed(2)} USD / ${plan.period}`,
				plan.name,
			);
			customerOption.dataset.enrollmentFee = String(plan.enrollmentFee);
			customerPlanSelect.add(customerOption);
		});
		if (plans.some((plan) => plan.name === selectedCustomerPlan)) customerPlanSelect.value = selectedCustomerPlan;
		updateCustomerEnrollmentAmount();
		customerPlanSelect.disabled = plans.length === 0;
		registerCustomerForm.querySelector('button[type="submit"]').disabled = plans.length === 0;
		customerPlansFeedback.textContent = plans.length
			? `${plans.length} plan(es) disponibles. Selecciona el plan asignado al cliente.`
			: "No hay planes disponibles. Crea un plan en la sección Planes para registrar clientes.";
		showFeedback(plansFeedback, `${plans.length} plan(es) disponibles para los clientes.`);
	} catch (error) {
		const customerPlanSelect = registerCustomerForm.elements.planName;
		customerPlanSelect.replaceChildren(new Option("No se pudieron cargar los planes", ""));
		customerPlanSelect.disabled = true;
		registerCustomerForm.querySelector('button[type="submit"]').disabled = true;
		customerPlansFeedback.textContent = "No se pudieron cargar los planes. Actualiza la página o inténtalo de nuevo.";
		showFeedback(plansFeedback, error.message || "No se pudieron cargar los planes.", "error");
	}
}

function renderCustomerRow(customer) {
	const row = document.createElement("tr");
	const nameCell = document.createElement("td");
	const name = document.createElement("span");
	name.className = "payment-name";
	name.textContent = customer.customer_name || "—";
	nameCell.append(name);

	const emailCell = document.createElement("td");
	emailCell.textContent = customer.customer_email || "—";
	const phoneCell = document.createElement("td");
	phoneCell.textContent = customer.customer_phone || "—";
	const planCell = document.createElement("td");
	planCell.textContent = customer.plan_name || "Sin plan asignado";
	const dateCell = document.createElement("td");
	const registrationDate = String(customer.enrollment_date || "").slice(0, 10);
	dateCell.textContent = registrationDate ? formatDueDate(registrationDate) : "—";
	const enrollmentAmountCell = document.createElement("td");
	enrollmentAmountCell.textContent = `$${Number(customer.enrollment_amount || 0).toFixed(2)}`;
	const proofCell = document.createElement("td");
	if (customer.enrollment_proof_name) {
		const proofButton = document.createElement("button");
		proofButton.className = "secondary-button";
		proofButton.type = "button";
		proofButton.textContent = "Ver comprobante";
		proofButton.addEventListener("click", () => loadCustomerEnrollmentProof(customer));
		proofCell.append(proofButton);
	} else {
		proofCell.textContent = "Sin comprobante";
	}
	const accessCell = document.createElement("td");
	const accessStatus = document.createElement("span");
	accessStatus.className = `status-pill${customer.has_customer_password ? " approved" : ""}`;
	accessStatus.textContent = customer.has_customer_password ? "Habilitado" : "Pendiente";
	accessCell.append(accessStatus);
	const actionsCell = document.createElement("td");
	const editButton = document.createElement("button");
	editButton.className = "secondary-button";
	editButton.type = "button";
	editButton.textContent = "Editar";
	editButton.addEventListener("click", () => openCustomerEditor(customer));
	const deleteButton = document.createElement("button");
	deleteButton.className = "delete-customer-button";
	deleteButton.type = "button";
	deleteButton.textContent = "Eliminar";
	deleteButton.addEventListener("click", async () => {
		if (!window.confirm(`¿Eliminar a ${customer.customer_name}? También se quitará del control de mensualidades. El historial de pagos se conservará.`)) return;
		deleteButton.disabled = true;
		showFeedback(customersFeedback, `Eliminando a ${customer.customer_name}...`);
		try {
			const data = await adminRequest(`/api/admin/customers/${encodeURIComponent(customer.id)}`, {
				method: "DELETE",
			});
			if (editCustomerForm.elements.customerId.value === String(customer.id)) {
				editCustomerForm.reset();
				editCustomerForm.hidden = true;
			}
			await Promise.all([loadCustomers(), loadMemberships()]);
			showFeedback(customersFeedback, data.message);
		} catch (error) {
			showFeedback(customersFeedback, error.message || "No se pudo eliminar al cliente.", "error");
			deleteButton.disabled = false;
		}
	});
	actionsCell.append(editButton, deleteButton);

	row.append(nameCell, emailCell, phoneCell, planCell, dateCell, enrollmentAmountCell, proofCell, accessCell, actionsCell);
	return row;
}

function normalizeCustomerSearch(value) {
	return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function renderCustomers() {
	const query = normalizeCustomerSearch(customerSearchInput.value);
	const phoneQuery = query.replace(/\D/g, "");
	const filteredCustomers = registeredCustomers.filter((customer) => {
		const nameAndPhone = normalizeCustomerSearch(
			`${customer.customer_name || ""} ${customer.customer_phone || ""}`,
		);
		const phone = String(customer.customer_phone || "").replace(/\D/g, "");
		return !query || nameAndPhone.includes(query) || (phoneQuery && phone.includes(phoneQuery));
	});

	customersList.replaceChildren(...filteredCustomers.map(renderCustomerRow));
	emptyCustomers.hidden = filteredCustomers.length !== 0;
	emptyCustomers.textContent = registeredCustomers.length === 0
		? "No hay clientes registrados."
		: "No se encontraron clientes con esa búsqueda.";
	showFeedback(customersFeedback, query
		? `${filteredCustomers.length} de ${registeredCustomers.length} cliente(s) encontrado(s).`
		: `${registeredCustomers.length} cliente(s) registrado(s).`);
}

function openCustomerEditor(customer) {
	const [firstName = "", ...lastNameParts] = String(customer.customer_name || "").trim().split(/\s+/);
	editCustomerForm.elements.customerId.value = customer.id;
	editCustomerForm.elements.firstName.value = firstName;
	editCustomerForm.elements.lastName.value = lastNameParts.join(" ");
	editCustomerForm.elements.phone.value = customer.customer_phone || "";
	editCustomerForm.elements.email.value = customer.customer_email || "";
	editCustomerForm.elements.registrationDate.value = String(customer.enrollment_date || "").slice(0, 10);
	editCustomerForm.elements.enrollmentAmount.value = Number(customer.enrollment_amount || 0).toFixed(2);
	editCustomerForm.hidden = false;
	editCustomerForm.scrollIntoView({ behavior: "smooth", block: "center" });
	editCustomerForm.elements.firstName.focus({ preventScroll: true });
}

async function loadCustomerEnrollmentProof(customer) {
	paymentDetail.hidden = false;
	paymentDetail.scrollIntoView({ behavior: "smooth", block: "start" });
	document.querySelector("#detail-title").textContent = "Comprobante de inscripción";
	paymentData.replaceChildren();
	receiptPreview.replaceChildren();
	approveButton.hidden = true;
	appendDetail("Cliente", customer.customer_name);
	appendDetail("Plan", customer.plan_name || "Sin plan asignado");
	appendDetail("Monto pagado", `$${Number(customer.enrollment_amount || 0).toFixed(2)} USD`);
	showFeedback(detailFeedback, "Cargando comprobante...");
	try {
		const data = await adminRequest(`/api/admin/customers/${encodeURIComponent(customer.id)}/enrollment-proof`);
		const image = document.createElement("img");
		image.src = `data:${data.proof.mimeType};base64,${data.proof.data}`;
		image.alt = `Comprobante de inscripción de ${customer.customer_name}`;
		receiptPreview.append(image);
		showFeedback(detailFeedback, data.proof.name);
	} catch (error) {
		showFeedback(detailFeedback, error.message || "No se pudo abrir el comprobante de inscripción.", "error");
	}
}

async function loadCustomers() {
	showFeedback(customersFeedback, "Cargando clientes registrados...");
	try {
		const data = await adminRequest("/api/admin/customers");
		registeredCustomers = data.customers;
		renderCustomers();
	} catch (error) {
		registeredCustomers = [];
		customersList.replaceChildren();
		emptyCustomers.hidden = true;
		showFeedback(customersFeedback, error.message || "No se pudieron cargar los clientes registrados.", "error");
	}
}

async function loadPaymentSettings() {
	showFeedback(paymentSettingsFeedback, "Cargando datos de Pago Móvil...");
	try {
		const data = await adminRequest("/api/admin/payment-settings");
		paymentSettingsForm.elements.bankName.value = data.settings.bankName;
		paymentSettingsForm.elements.bankCode.value = data.settings.bankCode;
		paymentSettingsForm.elements.documentId.value = data.settings.documentId;
		paymentSettingsForm.elements.phone.value = data.settings.phone;
		showFeedback(paymentSettingsFeedback, "Datos de Pago Móvil cargados.");
	} catch (error) {
		showFeedback(paymentSettingsFeedback, error.message || "No se pudieron cargar los datos de Pago Móvil.", "error");
	}
}

function renderPaymentRow(payment) {
	const row = document.createElement("tr");
	const customerCell = document.createElement("td");
	const customerName = document.createElement("span");
	customerName.className = "payment-name";
	customerName.textContent = payment.customer_name;
	const customerEmail = document.createElement("span");
	customerEmail.className = "payment-email";
	customerEmail.textContent = payment.customer_email;
	customerCell.append(customerName, customerEmail);

	const planCell = document.createElement("td");
	planCell.textContent = payment.plan_name;
	const statusCell = document.createElement("td");
	const status = document.createElement("span");
	status.className = `status-pill${payment.status === "approved" ? " approved" : ""}`;
	status.textContent = payment.status === "approved" ? "Aprobado" : "Pendiente";
	statusCell.append(status);

	const actionCell = document.createElement("td");
	const viewButton = document.createElement("button");
	viewButton.className = "view-payment";
	viewButton.type = "button";
	viewButton.textContent = "Revisar";
	viewButton.addEventListener("click", () => loadPayment(payment.id, payment.payment_type));
	actionCell.append(viewButton);
	row.append(customerCell, planCell, statusCell, actionCell);
	return row;
}

async function loadMonthlyPayments() {
	showFeedback(monthlyPaymentsFeedback, "Cargando comprobantes de mensualidad...");
	try {
		const data = await adminRequest(`/api/admin/payments?status=${encodeURIComponent(monthlyPaymentFilter.value)}&type=membership`);
		monthlyPaymentList.replaceChildren(...data.payments.map(renderPaymentRow));
		emptyMonthlyPayments.hidden = data.payments.length !== 0;
		showFeedback(monthlyPaymentsFeedback, `${data.payments.length} comprobante(s) de mensualidad cargado(s).`);
	} catch (error) {
		showFeedback(monthlyPaymentsFeedback, error.message || "No se pudieron cargar los comprobantes de mensualidad.", "error");
	}
}

function renderMemberships() {
	membershipsList.replaceChildren();
	memberships.forEach((membership) => membershipsList.append(renderMembershipRow(membership)));
	emptyMemberships.hidden = memberships.length !== 0;
	emptyMemberships.textContent = "No hay clientes en el control de mensualidades.";
}

function renderMembershipRow(membership) {
	const row = document.createElement("tr");
	const customerCell = document.createElement("td");
	customerCell.textContent = membership.customer_name;
	const planCell = document.createElement("td");
	planCell.textContent = membership.plan_name;
	const enrollmentDateCell = document.createElement("td");
	const enrollmentDate = String(membership.enrollment_date || "").slice(0, 10);
	enrollmentDateCell.textContent = enrollmentDate ? formatDueDate(enrollmentDate) : "—";
	const dueDateCell = document.createElement("td");
	const dueDate = String(membership.next_due_date).slice(0, 10);
	const time = document.createElement("time");
	time.dateTime = dueDate;
	time.textContent = formatDueDate(dueDate);
	dueDateCell.append(time);
	const amountCell = document.createElement("td");
	amountCell.textContent = `$${Number(membership.monthly_amount).toFixed(2)} USD`;
	const statusCell = document.createElement("td");
	statusCell.className = `membership-status${membership.gym_access_restricted ? " is-restricted" : membership.days_overdue > 0 ? " is-overdue" : ""}`;
	statusCell.textContent = membership.gym_access_restricted
		? membership.days_overdue > 0
			? `Acceso restringido · ${membership.days_overdue} día(s) de mora`
			: "Pago actualizado · acceso pendiente de habilitación"
		: membership.days_overdue > 0
			? `Moroso · ${membership.days_overdue} día(s)`
			: membership.payment_status === "due_today" ? "Vence hoy" : "Al día";
	const remindersCell = document.createElement("td");
	remindersCell.textContent = `7 días: ${membership.reminder_7_days_sent ? "enviado" : "pendiente"} · 1 día: ${membership.reminder_1_day_sent ? "enviado" : "pendiente"}`;
	const accessCell = document.createElement("td");
	const accessButton = document.createElement("button");
	accessButton.className = "secondary-button membership-access-button";
	accessButton.type = "button";
	accessButton.textContent = membership.gym_access_restricted ? "Habilitar acceso e instalaciones" : "Restringir acceso";
	accessButton.disabled = !membership.gym_access_restricted && membership.days_overdue <= 5;
	if (accessButton.disabled) {
		accessButton.title = "Disponible cuando la mensualidad tenga más de 5 días de mora.";
	}
	accessButton.addEventListener("click", async () => {
		const restricted = !membership.gym_access_restricted;
		const confirmation = restricted
			? `¿Restringir el acceso al gimnasio de ${membership.customer_name}? Tiene ${membership.days_overdue} días de mora.`
			: `¿Habilitar nuevamente las instalaciones y los beneficios del plan de ${membership.customer_name}?`;
		if (!window.confirm(confirmation)) return;
		accessButton.disabled = true;
		showFeedback(membershipsFeedback, restricted ? "Restringiendo acceso..." : "Habilitando acceso...");
		try {
			const data = await adminRequest(`/api/admin/memberships/${encodeURIComponent(membership.id)}/access`, {
				method: "PATCH",
				body: JSON.stringify({ restricted }),
			});
			await loadMemberships();
			showFeedback(membershipsFeedback, data.message);
		} catch (error) {
			showFeedback(membershipsFeedback, error.message || "No se pudo actualizar el acceso.", "error");
			accessButton.disabled = false;
		}
	});
	accessCell.append(accessButton);
	row.append(customerCell, planCell, enrollmentDateCell, dueDateCell, amountCell, statusCell, remindersCell, accessCell);
	return row;
}

async function loadMemberships() {
	showFeedback(membershipsFeedback, "Cargando control de mensualidades...");
	try {
		const data = await adminRequest("/api/admin/memberships");
		memberships = data.memberships;
		renderMemberships();
		showFeedback(membershipsFeedback, `${memberships.length} cliente(s) en el control.`);
	} catch (error) {
		showFeedback(membershipsFeedback, error.message || "No se pudo cargar el control de mensualidades.", "error");
	}
}

async function loadPayment(id, paymentType = "enrollment") {
	selectedPaymentId = id;
	selectedPaymentType = paymentType;
	paymentDetail.hidden = false;
	document.querySelector("#detail-title").textContent = paymentType === "membership"
		? "Detalle del pago de mensualidad"
		: "Detalle del pago de inscripción";
	approveButton.textContent = paymentType === "membership"
		? "Aprobar mensualidad y enviar factura"
		: "Aprobar pago y enviar factura";
	paymentData.replaceChildren();
	receiptPreview.replaceChildren();
	approveButton.hidden = true;
	showFeedback(detailFeedback, "Abriendo comprobante...");
	try {
		const data = await adminRequest(`/api/admin/payments/${encodeURIComponent(id)}`);
		const payment = data.payment;
		appendDetail("Cliente", payment.customer_name);
		appendDetail("Correo", payment.customer_email);
		appendDetail("Teléfono", payment.customer_phone);
		appendDetail("Plan(es)", payment.plans?.map((plan) => plan.name).join(", ") || payment.plan_name);
		appendDetail("Tipo de pago", payment.payment_type === "membership" ? "Mensualidad" : "Inscripción");
		if (payment.payment_type !== "membership" && payment.plans?.length > 1) {
			payment.plans.forEach((plan) => {
				appendDetail(
					plan.name,
					`Inscripción: $${Number(plan.enrollmentFee).toFixed(2)} USD; ${plan.period}: $${Number(plan.membershipFee).toFixed(2)} USD`,
				);
			});
		}
		appendDetail("Monto", `$${Number(payment.payment_amount).toFixed(2)} USD`);
		appendDetail("Método de pago", payment.payment_method);
		appendDetail("Fecha de pago", new Date(`${payment.payment_date}T00:00:00`).toLocaleDateString("es-VE"));
		appendDetail("Enviado", new Date(payment.submitted_at).toLocaleString("es-VE"));
		appendDetail("Estado", payment.status === "approved" ? "Aprobado" : "Pendiente de confirmación");

		const receiptUrl = `data:${payment.receipt_mime_type};base64,${payment.receipt_data}`;
		if (payment.receipt_mime_type.startsWith("image/")) {
			const image = document.createElement("img");
			image.src = receiptUrl;
			image.alt = `Comprobante de pago de ${payment.customer_name}`;
			receiptPreview.append(image);
		} else if (payment.receipt_mime_type === "application/pdf") {
			const pdf = document.createElement("iframe");
			pdf.src = receiptUrl;
			pdf.title = `Comprobante de pago de ${payment.customer_name}`;
			receiptPreview.append(pdf);
		} else {
			const link = document.createElement("a");
			link.href = receiptUrl;
			link.download = payment.receipt_name;
			link.className = "receipt-download";
			link.textContent = `Descargar ${payment.receipt_name}`;
			receiptPreview.append(link);
		}
		approveButton.hidden = payment.status !== "pending";
		showFeedback(detailFeedback, "");
	} catch (error) {
		showFeedback(detailFeedback, error.message || "No se pudo abrir el comprobante.", "error");
	}
}

loginForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	showFeedback(loginFeedback, "");
	const button = loginForm.querySelector("button[type=submit]");
	button.disabled = true;
	try {
		const data = await adminRequest("/api/admin/login", {
			method: "POST",
			body: JSON.stringify({
				email: document.querySelector("#admin-email").value.trim(),
				password: document.querySelector("#admin-password").value,
			}),
		});
		adminToken = data.token;
		localStorage.setItem("adminToken", adminToken);
		loginForm.reset();
		showDashboard();
	} catch (error) {
		showFeedback(loginFeedback, error.message || "No se pudo iniciar sesión.", "error");
	} finally {
		button.disabled = false;
	}
});

planForm.elements.image.required = true;
planForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	showFeedback(plansFeedback, "");
	const submitButton = planForm.querySelector('button[type="submit"]');
	const planId = planForm.elements.planId.value;
	const formData = new FormData(planForm);
	submitButton.disabled = true;
	try {
		const data = await adminRequest(planId ? `/api/admin/plans/${encodeURIComponent(planId)}` : "/api/admin/plans", {
			method: planId ? "PUT" : "POST",
			body: formData,
		});
		resetPlanForm();
		await loadPlans();
		showFeedback(plansFeedback, data.message);
	} catch (error) {
		showFeedback(plansFeedback, error.message || "No se pudo guardar el plan.", "error");
	} finally {
		submitButton.disabled = false;
	}
});

paymentSettingsForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	showFeedback(paymentSettingsFeedback, "");
	const submitButton = paymentSettingsForm.querySelector('button[type="submit"]');
	const values = Object.fromEntries(new FormData(paymentSettingsForm).entries());
	submitButton.disabled = true;
	try {
		const data = await adminRequest("/api/admin/payment-settings", {
			method: "PUT",
			body: JSON.stringify(values),
		});
		showFeedback(paymentSettingsFeedback, `${data.message} Se reflejarán en los próximos pagos que abran los clientes.`);
	} catch (error) {
		showFeedback(paymentSettingsFeedback, error.message || "No se pudieron guardar los datos de pago.", "error");
	} finally {
		submitButton.disabled = false;
	}
});

resetPlanFormButton.addEventListener("click", resetPlanForm);

document.querySelector("#admin-logout").addEventListener("click", signOut);
document.querySelector("#refresh-monthly-payments").addEventListener("click", loadMonthlyPayments);
document.querySelector("#refresh-memberships").addEventListener("click", loadMemberships);
document.querySelector("#refresh-customers").addEventListener("click", loadCustomers);
customerSearchInput.addEventListener("input", renderCustomers);
document.querySelector("#cancel-customer-edit").addEventListener("click", () => {
	editCustomerForm.reset();
	editCustomerForm.hidden = true;
});
monthlyPaymentFilter.addEventListener("change", loadMonthlyPayments);

registrationDateInput.value = localDateValue();
registrationDateInput.max = localDateValue();
editCustomerForm.elements.registrationDate.max = localDateValue();
registerCustomerForm.elements.planName.addEventListener("change", updateCustomerEnrollmentAmount);
editCustomerForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	showFeedback(customersFeedback, "");
	const submitButton = editCustomerForm.querySelector('button[type="submit"]');
	const values = Object.fromEntries(new FormData(editCustomerForm).entries());
	values.firstName = String(values.firstName).trim();
	values.lastName = String(values.lastName).trim();
	values.phone = String(values.phone).trim();
	values.email = String(values.email).trim().toLowerCase();
	values.registrationDate = String(values.registrationDate).trim();
	submitButton.disabled = true;
	try {
		const data = await adminRequest(`/api/admin/customers/${encodeURIComponent(values.customerId)}`, {
			method: "PATCH",
			body: JSON.stringify(values),
		});
		editCustomerForm.reset();
		editCustomerForm.hidden = true;
		showFeedback(customersFeedback, data.message);
		await loadCustomers();
		await loadMemberships();
	} catch (error) {
		showFeedback(customersFeedback, error.message || "No se pudo actualizar el cliente.", "error");
	} finally {
		submitButton.disabled = false;
	}
});
registerCustomerForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	showFeedback(registerCustomerFeedback, "");
	const submitButton = registerCustomerForm.querySelector('button[type="submit"]');
	const formData = new FormData(registerCustomerForm);
	for (const field of ["firstName", "lastName", "phone", "email", "planName", "registrationDate"]) {
		formData.set(field, String(formData.get(field)).trim());
	}
	submitButton.disabled = true;
	try {
		const data = await adminRequest("/api/admin/customers", {
			method: "POST",
			body: formData,
		});
		registerCustomerForm.reset();
		registrationDateInput.value = localDateValue();
		updateCustomerEnrollmentAmount();
		showFeedback(registerCustomerFeedback, data.nextDueDate
			? `${data.message} Próximo pago: ${formatDueDate(data.nextDueDate)}.`
			: data.message);
		await loadCustomers();
		if (data.membershipId) await loadMemberships();
	} catch (error) {
		showFeedback(registerCustomerFeedback, error.message || "No se pudo registrar el cliente.", "error");
	} finally {
		submitButton.disabled = false;
	}
});
customerAccessForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	showFeedback(customerAccessFeedback, "");
	const submitButton = customerAccessForm.querySelector('button[type="submit"]');
	const values = Object.fromEntries(new FormData(customerAccessForm).entries());
	values.email = String(values.email).trim();
	submitButton.disabled = true;
	try {
		const data = await adminRequest("/api/admin/customers/access", {
			method: "PUT",
			body: JSON.stringify(values),
		});
		customerAccessForm.reset();
		showFeedback(customerAccessFeedback, data.message);
		await loadCustomers();
	} catch (error) {
		showFeedback(customerAccessFeedback, error.message || "No se pudo actualizar el acceso.", "error");
	} finally {
		submitButton.disabled = false;
	}
});
approveButton.addEventListener("click", async () => {
	const confirmationMessage = selectedPaymentType === "membership"
		? "¿Confirmas que verificaste este pago de mensualidad y deseas aprobarlo? Se actualizará el próximo vencimiento y se enviará la factura. Si el acceso estaba restringido, deberás habilitarlo manualmente desde el control de mensualidades."
		: "¿Confirmas que verificaste este pago y deseas aprobarlo? Se enviará la factura al correo del cliente.";
	if (!selectedPaymentId || !window.confirm(confirmationMessage)) return;
	approveButton.disabled = true;
	showFeedback(detailFeedback, "Enviando confirmación y factura...");
	try {
		const data = await adminRequest(`/api/admin/payments/${encodeURIComponent(selectedPaymentId)}/approve`, {
			method: "POST",
		});
		showFeedback(detailFeedback, data.message);
		await loadMonthlyPayments();
		if (selectedPaymentType === "membership") await loadMemberships();
		await loadPayment(selectedPaymentId, selectedPaymentType);
	} catch (error) {
		showFeedback(detailFeedback, error.message || "No se pudo aprobar el pago.", "error");
	} finally {
		approveButton.disabled = false;
	}
});

if (adminToken) showDashboard();
