import XCTest
@testable import SFUBadminton

// Port of StatementTest.kt (the Expo app's src/__tests__/statement.test.ts).
final class StatementTests: XCTestCase {
    private let season = StatementSeason(id: "s1", name: "Fall 2026", endDate: "2026-12-10", competitiveFeeCents: 6000, recreationalFeeCents: 4000)

    private func fee(
        id: String = "f",
        feeType: String = "dues",
        seasonId: String? = nil,
        tournamentId: String? = nil,
        clubEventId: String? = nil,
        amountCents: Int? = nil,
        paidAt: String? = nil,
        method: String? = nil,
    ) -> OwnFeeRow {
        OwnFeeRow(id: id, feeType: feeType, seasonId: seasonId, tournamentId: tournamentId, clubEventId: clubEventId, amountCents: amountCents, paidAt: paidAt, method: method, reference: nil, createdAt: "2026-09-01T00:00:00Z")
    }

    private let member = StatementPlayer(status: "competitive", isExec: false, feeExempt: false)

    private func with(_ change: (inout StatementPlayer) -> Void) -> StatementPlayer {
        var p = member
        change(&p)
        return p
    }

    private func statement(
        _ player: StatementPlayer,
        _ rows: [OwnFeeRow],
        names: [String: String] = [:],
        eventNames: [String: String] = [:],
    ) -> (StatementLines, OutstandingSummary, Headline) {
        let built = buildStatementLines(player: player, season: season, feeRows: rows, tournamentNames: names, eventNames: eventNames)
        let summary = summariseFees(built.lines, exempt: isExempt(player))
        return (built, summary, statementHeadline(summary))
    }

    func test_aMemberWithNoDuesRowOwesTheSeasonPriceForTheirStatus() {
        let (built, summary, headline) = statement(member, [])
        XCTAssertEqual("season-s1", built.seasonLine?.key)
        XCTAssertEqual(6000, built.seasonLine?.owedCents)
        XCTAssertEqual(.owing, summary.status)
        XCTAssertEqual(Headline(amount: "$60.00", label: "UNPAID"), headline)
    }

    func test_aRecreationalMemberOwesTheRecreationalPrice() {
        let (_, summary, _) = statement(with { $0.status = "recreational" }, [])
        XCTAssertEqual(4000, summary.totalCents)
    }

    func test_anExemptMemberGetsNoDuesLineAndIsNotCharged() {
        let (built, summary, headline) = statement(with { $0.feeExempt = true }, [])
        XCTAssertNil(built.seasonLine)
        XCTAssertEqual(.exempt, summary.status)
        XCTAssertEqual(Headline(amount: "$0.00", label: "NOT CHARGED"), headline)
    }

    func test_anExecStillOwesAReinstatementWhichIsNotADue() {
        let (_, summary, _) = statement(with { $0.isExec = true }, [fee(id: "r", feeType: "reinstatement", amountCents: 2500)])
        XCTAssertEqual(.owing, summary.status)
        XCTAssertEqual(2500, summary.totalCents)
    }

    func test_aWaivedDuesRowIsSettledAndItsReceiptSaysWaivedRatherThanPaid() {
        let rows = [fee(id: "d", seasonId: "s1", amountCents: 0, paidAt: "2026-09-05T18:00:00Z", method: "Waived")]
        let (built, summary, headline) = statement(member, rows)
        XCTAssertTrue(built.seasonLine!.waived)
        XCTAssertFalse(built.seasonLine!.paid)
        XCTAssertEqual(.allPaid, summary.status)
        XCTAssertEqual(["d"], summary.receipts.map(\.key))
        XCTAssertEqual("ALL PAID", headline.label)
    }

    func test_anEntryWithNoRecordedPriceMakesTheTotalUnknownNotZero() {
        let rows = [
            fee(id: "d", seasonId: "s1", amountCents: 6000, paidAt: "2026-09-05T18:00:00Z", method: "e_transfer"),
            fee(id: "t", feeType: "tournament", tournamentId: "t1"),
        ]
        let (built, summary, headline) = statement(member, rows, names: ["t1": "Fall Open"])
        XCTAssertEqual(["Fall 2026 membership", "Fall Open"], built.lines.map(\.name))
        XCTAssertEqual(1, summary.unknownCount)
        XCTAssertEqual("TBD", headline.amount)
    }

    func test_aTournamentTheMemberCanNoLongerReadKeepsItsFeeUnderAGenericName() {
        let rows = [fee(id: "t", feeType: "tournament", tournamentId: "gone", amountCents: 1500)]
        let (built, _, _) = statement(with { $0.feeExempt = true }, rows)
        XCTAssertEqual(["Tournament entry"], built.lines.map(\.name))
    }

    func test_noSeasonAndNoRowsIsNothingDue() {
        let built = buildStatementLines(player: member, season: nil, feeRows: [], tournamentNames: [:], eventNames: [:])
        XCTAssertTrue(built.lines.isEmpty)
        XCTAssertEqual(Headline(amount: "$0.00", label: "NOTHING DUE"), statementHeadline(summariseFees(built.lines, exempt: false)))
    }

    // localeCompare puts "alpha" before "Beta"; a plain comparison puts every
    // capital first.
    func test_ordersEntriesByNameTheWayLocaleCompareDoes() {
        let rows = [
            fee(id: "1", feeType: "tournament", tournamentId: "t1", amountCents: 100),
            fee(id: "2", feeType: "tournament", tournamentId: "t2", amountCents: 100),
            fee(id: "3", feeType: "event", clubEventId: "e1", amountCents: 100),
            fee(id: "4", feeType: "event", clubEventId: "e2", amountCents: 100),
        ]
        let (built, _, _) = statement(
            with { $0.feeExempt = true },
            rows,
            names: ["t1": "Beta Cup", "t2": "alpha Open"],
            eventNames: ["e1": "Zumba night", "e2": "banquet"],
        )
        XCTAssertEqual(["alpha Open", "Beta Cup", "banquet", "Zumba night"], built.lines.map(\.name))
    }
}
