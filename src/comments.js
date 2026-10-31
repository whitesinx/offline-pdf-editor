// Comments: speech-bubble markers on the page, a card to read/write/edit each
// one, and a side panel listing them all. Stored as standard PDF Text
// annotations by PdfEngine, so they travel with the downloaded file.

const AUTHOR_KEY = "commentAuthor";
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" });

export function createComments({ state, viewer, panel, status, beforeChange, afterChange }) {
	let mode = false;
	let card = null; // { el, page, comment }

	const all = () =>
		state.pages
			.flatMap((p) => p.comments || [])
			.sort((a, b) => a.pageIndex - b.pageIndex || a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0]);
	const numberOf = (c) => all().findIndex((x) => x.id === c.id && x.pageIndex === c.pageIndex) + 1;

	// ---- Mode ----------------------------------------------------------------

	function setMode(on) {
		mode = on;
		document.body.classList.toggle("comment-mode", on);
		if (on) {
			showPanel(true);
			status("Click anywhere on a page to place a comment. Press Esc to stop.");
		}
		document.dispatchEvent(new CustomEvent("comment-mode", { detail: on }));
	}

	// ---- Pins ----------------------------------------------------------------

	function pins(page) {
		const z = state.zoom;
		return (page.comments || []).map((c) => {
			const [x0, y0, x1, y1] = c.bounds;
			const size = Math.max(20, Math.max(x1 - x0, y1 - y0) * z);
			const pin = document.createElement("button");
			pin.className = "comment-pin";
			pin.style.left = x0 * z + "px";
			pin.style.top = y0 * z + "px";
			pin.style.width = pin.style.height = size + "px";
			pin.title = `Comment ${numberOf(c)} by ${c.author || "Unknown"}`;
			pin.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8.5L7 21v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/></svg><span></span>`;
			pin.querySelector("span").textContent = numberOf(c);
			pin.addEventListener("click", (ev) => {
				ev.stopPropagation();
				openCard(page, c);
			});
			return pin;
		});
	}

	function refreshPins() {
		for (const page of state.pages) {
			if (!page.rendered) continue;
			page.el.querySelectorAll(".comment-pin").forEach((el) => el.remove());
			page.el.append(...pins(page));
		}
	}

	// ---- Card ----------------------------------------------------------------

	function closeCard() {
		card?.el.remove();
		card = null;
		panel.querySelectorAll(".comment-item.active").forEach((el) => el.classList.remove("active"));
	}

	function cardShell(page, anchor) {
		closeCard();
		const z = state.zoom;
		const el = document.createElement("div");
		el.className = "comment-card";
		el.addEventListener("click", (ev) => ev.stopPropagation());
		el.addEventListener("mousedown", (ev) => ev.stopPropagation());
		const [ax, ay, ax1, ay1] = anchor;
		const width = Math.min(300, window.innerWidth - 32);
		const pageW = page.width * z;
		if (ax1 * z + 10 + width <= pageW) {
			el.style.left = ax1 * z + 10 + "px"; // right of the bubble
			el.style.top = Math.max(0, ay * z - 4) + "px";
		} else if (ax * z - 10 - width >= 0) {
			el.style.left = ax * z - 10 - width + "px"; // left of it
			el.style.top = Math.max(0, ay * z - 4) + "px";
		} else {
			// Narrow page: below the bubble, kept inside the page horizontally where possible.
			el.style.left = Math.max(Math.min(0, pageW - width), Math.min(ax * z - 12, pageW - width)) + "px";
			el.style.top = ay1 * z + 8 + "px";
		}
		page.el.append(el);
		return el;
	}

	function openCard(page, comment) {
		const el = cardShell(page, comment.bounds);
		card = { el, page, comment };
		highlightItem(comment);

		const head = header(comment.author, comment.created, numberOf(comment));
		const body = document.createElement("p");
		body.className = "comment-body";
		body.textContent = comment.text || "(No text)";
		const meta = document.createElement("div");
		meta.className = "comment-meta";
		if (comment.modified && comment.created && comment.modified - comment.created > 1000)
			meta.textContent = `Edited ${dateFmt.format(comment.modified)}`;

		const actions = document.createElement("div");
		actions.className = "comment-actions";
		const edit = button("Edit", () => openEditor(page, null, comment));
		const del = button("Delete", () => confirmDelete());
		del.classList.add("danger");
		const close = button("Close", closeCard);
		actions.append(edit, del, spacer(), close);
		el.append(head, body, meta, actions);

		function confirmDelete() {
			actions.replaceChildren();
			const q = document.createElement("span");
			q.className = "comment-confirm";
			q.textContent = "Delete this comment?";
			const yes = button("Delete", () => remove(page, comment), "danger primary");
			actions.append(q, spacer(), button("Cancel", () => openCard(page, comment)), yes);
		}
	}

	// comment = null for a new one at `point` (page space).
	function openEditor(page, point, comment = null) {
		const anchor = comment ? comment.bounds : [point[0], point[1], point[0] + 20, point[1] + 20];
		const el = cardShell(page, anchor);
		card = { el, page, comment };

		const title = document.createElement("div");
		title.className = "comment-title";
		title.textContent = comment ? `Edit comment ${numberOf(comment)}` : `New comment · Page ${page.index + 1}`;

		const nameLabel = field("Name");
		const name = document.createElement("input");
		name.className = "comment-input";
		name.value = comment?.author || savedAuthor();
		name.placeholder = "Your name";
		nameLabel.append(name);

		const textLabel = field("Comment");
		const text = document.createElement("textarea");
		text.className = "comment-input";
		text.rows = 4;
		text.value = comment?.text || "";
		text.placeholder = "Write your comment…";
		textLabel.append(text);

		const actions = document.createElement("div");
		actions.className = "comment-actions";
		const hint = document.createElement("span");
		hint.className = "comment-hint";
		hint.textContent = "⌘↵ to post";
		const cancel = button("Cancel", () => (comment ? openCard(page, comment) : closeCard()));
		const save = button(comment ? "Save" : "Post comment", submit, "primary");
		actions.append(hint, spacer(), cancel, save);
		el.append(title, nameLabel, textLabel, actions);

		const sync = () => (save.disabled = !text.value.trim());
		sync();
		text.addEventListener("input", sync);
		for (const input of [name, text])
			input.addEventListener("keydown", (ev) => {
				if (ev.key === "Escape") (ev.stopPropagation(), cancel.click());
				if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) (ev.preventDefault(), submit());
			});
		text.focus();

		function submit() {
			const body = text.value.trim();
			if (!body) return;
			const author = name.value.trim() || "Reviewer";
			saveAuthor(author);
			const id = comment ? comment.id : null;
			const ok = change(page, () => {
				if (comment) state.engine.updateComment(page.index, comment.id, body, author);
				else return state.engine.addComment(page.index, point, body, author);
			}, comment ? "Comment updated." : "Comment added.");
			if (ok === false) return;
			const fresh = page.comments.find((c) => c.id === (id ?? ok));
			if (fresh) openCard(page, fresh);
			else closeCard();
		}
	}

	function remove(page, comment) {
		change(page, () => state.engine.deleteComment(page.index, comment.id), "Comment deleted.");
		closeCard();
	}

	// Run an engine change with undo support, then refresh pins and the panel.
	function change(page, fn, message) {
		try {
			beforeChange(page);
			const result = fn();
			page.comments = state.engine.listComments(page.index);
			afterChange(page);
			refresh();
			status(message);
			return result;
		} catch (err) {
			console.error(err);
			state.history.pop();
			status(`Comment failed: ${err.message}`, true);
			return false;
		}
	}

	// ---- Placing -------------------------------------------------------------

	function place(page, ev) {
		if (!mode) return false;
		const rect = page.el.getBoundingClientRect();
		const z = state.zoom;
		const x = Math.min(page.width - 20, Math.max(0, (ev.clientX - rect.left) / z - 4));
		const y = Math.min(page.height - 20, Math.max(0, (ev.clientY - rect.top) / z - 4));
		openEditor(page, [x, y]);
		return true;
	}

	// ---- Panel ---------------------------------------------------------------

	function showPanel(on) {
		document.body.classList.toggle("show-comments", on);
		document.dispatchEvent(new CustomEvent("comments-panel", { detail: on }));
	}

	function renderPanel() {
		const list = all();
		const head = document.createElement("div");
		head.className = "comments-head";
		const h = document.createElement("h2");
		h.textContent = "Comments";
		const count = document.createElement("span");
		count.className = "comments-count";
		count.textContent = list.length;
		h.append(count);
		const close = button("×", () => showPanel(false), "icon");
		close.title = "Hide comments";
		head.append(h, close);

		const items = document.createElement("div");
		items.className = "comments-list";
		if (!list.length) {
			const empty = document.createElement("p");
			empty.className = "comments-empty";
			empty.textContent = "No comments yet. Choose Add comment, then click anywhere on a page.";
			items.append(empty);
		}
		for (const c of list) {
			const item = document.createElement("button");
			item.className = "comment-item";
			item.dataset.key = `${c.pageIndex}:${c.id}`;
			const top = document.createElement("div");
			top.className = "comment-item-top";
			const num = document.createElement("span");
			num.className = "comment-num";
			num.textContent = numberOf(c);
			const who = document.createElement("strong");
			who.textContent = c.author || "Unknown";
			const where = document.createElement("span");
			where.className = "comment-page";
			where.textContent = `Page ${c.pageIndex + 1}`;
			top.append(num, who, where);
			const text = document.createElement("div");
			text.className = "comment-excerpt";
			text.textContent = c.text;
			const when = document.createElement("div");
			when.className = "comment-date";
			when.textContent = c.created ? dateFmt.format(c.created) : "";
			item.append(top, text, when);
			item.onclick = () => reveal(c);
			items.append(item);
		}
		panel.replaceChildren(head, items);
	}

	function reveal(c) {
		const page = state.pages[c.pageIndex];
		const z = state.zoom;
		viewer.scrollTo({ top: page.el.offsetTop + c.bounds[1] * z - 120, behavior: "smooth" });
		const open = () => {
			const fresh = page.comments.find((x) => x.id === c.id);
			if (fresh) openCard(page, fresh);
		};
		if (page.rendered) open();
		else setTimeout(open, 400);
	}

	function highlightItem(c) {
		panel.querySelectorAll(".comment-item").forEach((el) => el.classList.toggle("active", el.dataset.key === `${c.pageIndex}:${c.id}`));
	}

	function refresh() {
		refreshPins();
		renderPanel();
	}

	return {
		pins,
		place,
		refresh,
		closeCard,
		showPanel,
		get mode() {
			return mode;
		},
		setMode,
		count: () => all().length,
	};
}

function header(author, created, number) {
	const head = document.createElement("div");
	head.className = "comment-head";
	const avatar = document.createElement("span");
	avatar.className = "comment-avatar";
	avatar.textContent = initials(author);
	const who = document.createElement("div");
	who.className = "comment-who";
	const name = document.createElement("strong");
	name.textContent = author || "Unknown";
	const date = document.createElement("span");
	date.textContent = created ? dateFmt.format(created) : "";
	who.append(name, date);
	const num = document.createElement("span");
	num.className = "comment-num";
	num.textContent = number;
	head.append(avatar, who, num);
	return head;
}

function initials(name) {
	const parts = (name || "?").trim().split(/\s+/).filter(Boolean);
	return ((parts[0]?.[0] || "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function button(label, onClick, cls = "") {
	const b = document.createElement("button");
	b.className = `btn small ${cls}`.trim();
	b.textContent = label;
	b.onclick = (ev) => {
		ev.stopPropagation();
		onClick();
	};
	return b;
}

function field(label) {
	const l = document.createElement("label");
	l.className = "comment-field";
	const s = document.createElement("span");
	s.textContent = label;
	l.append(s);
	return l;
}

function spacer() {
	const s = document.createElement("span");
	s.style.flex = "1";
	return s;
}

function savedAuthor() {
	try {
		return localStorage.getItem(AUTHOR_KEY) || "";
	} catch {
		return "";
	}
}

function saveAuthor(name) {
	try {
		localStorage.setItem(AUTHOR_KEY, name);
	} catch {}
}
